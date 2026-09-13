import { homedir } from 'node:os';
import { desktopDataDir, desktopNativeOrigin, desktopPorts } from './options.ts';
import { startDesktopServer } from './server.ts';
import { evaluateNative, NativeInferenceManager } from './inference.ts';
import { InferenceGeometryStore } from './inference-geometry.ts';

let backend: Awaited<ReturnType<typeof startDesktopServer>> | undefined;
let window: Deno.BrowserWindow | undefined;
let inference: NativeInferenceManager<Deno.BrowserWindow> | undefined;
let shutdownTask: Promise<void> | undefined;
let mayClose = false;
const startup = Promise.withResolvers<void>();
const ready = startup.promise;

function shutdown(): Promise<void> {
  return shutdownTask ??= (async () => {
    let failed = false;
    // Mark the inference manager as stopping immediately, including during startup.
    const childClosed = inference?.shutdown();
    try { await childClosed; }
    catch (error) { console.error('MCM inference shutdown failed:', error); failed = true; }
    await ready.catch(() => {});
    try { await backend?.close(); }
    catch (error) { console.error('MCM shutdown failed:', error); failed = true; }
    finally {
      mayClose = true;
      window?.close();
      Deno.removeSignalListener('SIGINT', onSignal);
      if (Deno.build.os !== 'windows') Deno.removeSignalListener('SIGTERM', onSignal);
    }
    if (failed) Deno.exit(1);
  })();
}
function onSignal(): void { void shutdown(); }

try {
  const origin = desktopNativeOrigin(Deno.env.toObject());
  window = new Deno.BrowserWindow({ title: 'MCM — Model Config Manager', width: 1280, height: 900 });
  inference = new NativeInferenceManager({
    main: window, origin, ready, createWindow: options => new Deno.BrowserWindow(options),
    geometry: new InferenceGeometryStore(desktopDataDir(Deno.build.os === 'windows' ? 'win32' : Deno.build.os, Deno.env.toObject(), homedir())),
  });
  inference.registerBindings();
  window.addEventListener('close', event => {
    if (mayClose) return;
    event.preventDefault();
    // Startup can still be acquiring resources when the user closes the window.
    void shutdown();
  });
} catch (error) {
  console.error('MCM desktop startup failed:', error);
  Deno.exit(1);
}
Deno.addSignalListener('SIGINT', onSignal);
if (Deno.build.os !== 'windows') Deno.addSignalListener('SIGTERM', onSignal);
void (async () => {
  const env = Deno.env.toObject();
  backend = await startDesktopServer({
    dataDir: desktopDataDir(Deno.build.os === 'windows' ? 'win32' : Deno.build.os, env, homedir()),
    // Deno remaps the first Node HTTP listener to its native address once.
    ports: desktopPorts(env).toReversed(),
    interceptorModule: env.MCM_INTERCEPTOR_MODULE,
  });
  console.log(`MCM desktop ready; API http://127.0.0.1:${desktopPorts(env)[0]}`);
})().then(startup.resolve, startup.reject);
await ready.catch(async error => {
  console.error('MCM desktop startup failed:', error);
  // Deno desktop's native error reporter displays uncaught failures, including in GUI launches.
  await shutdown();
  throw error;
});
if (Deno.env.get('MCM_DESKTOP_SMOKE') === '1') {
  try {
    const evaluate = (script: string) => evaluateNative(window, script);
    let loaded = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        loaded = await evaluate(`
          Boolean(document.querySelector('#root')?.children.length)
        `) === true;
      } catch { /* The initial native navigation may not have completed yet. */ }
      if (loaded) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!loaded) {
      const state = await evaluate(`JSON.stringify({ url: location.href, ready: document.readyState, root: document.querySelector('#root')?.innerHTML.slice(0, 500) })`);
      throw new Error(`Native WebView did not render the MCM frontend: ${JSON.stringify(state)}`);
    }
    // WebKitGTK cannot serialize a Promise returned directly by evaluate_javascript.
    await evaluate(`fetch('/api/bootstrap').then(response => {
      document.documentElement.dataset.mcmSmokeApi = String(response.status);
    }).catch(() => { document.documentElement.dataset.mcmSmokeApi = 'failed'; }); 'started'`);
    let status: unknown;
    for (let attempt = 0; attempt < 100; attempt++) {
      status = await evaluate(`document.documentElement.dataset.mcmSmokeApi || ''`);
      if (status) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (status !== '200') throw new Error('Native WebView could not access the same-origin management API.');
    const waitFor = async (target: Deno.BrowserWindow, script: string, message: string) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await evaluateNative(target, script) === true) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const state = await evaluateNative(target, `JSON.stringify({
        url: location.href, theme: document.documentElement.dataset.theme,
        bindings: typeof window.bindings,
        errors: [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent),
        root: document.querySelector('#root')?.innerHTML.slice(0, 1200)
      })`);
      throw new Error(`${message} Native theme: ${await inference.bindings.mcmGetInferenceTheme()}. ${String(state)}`);
    };
    await waitFor(window, `!!document.querySelector('[aria-label="Open inference picture-in-picture"]')`, 'Native inference button did not render.');
    await evaluate(`document.documentElement.dataset.theme = 'nord';
    window.addEventListener('mcm-inference-state', event => {
      document.documentElement.dataset.mcmSmokeInferenceState = String(event.detail.open);
    }); document.querySelector('[aria-label="Open inference picture-in-picture"]').click(); 'started'`);
    await waitFor(window, `!!document.querySelector('[aria-label="Restore inference card"]')`, 'Native inference button did not open a window.');
    const child = inference.nativeWindow;
    if (!child || child.isClosed()) throw new Error('Native inference window was not created.');
    await waitFor(child, `location.origin === ${JSON.stringify(desktopNativeOrigin(Deno.env.toObject()))}
      && location.pathname === '/inference'
      && !!document.querySelector('.native-inference-page .runtime-card')`, 'Native inference page did not render at the native origin.');
    if (Deno.build.os === 'linux') {
      // Laufey 0.7's GTK getter can report false while X11 confirms ABOVE.
      const check = await new Deno.Command(Deno.env.get('MCM_DESKTOP_SMOKE_XPROP') || 'xprop', {
        args: ['-name', 'MCM Inference', '_NET_WM_STATE'], stdout: 'piped', stderr: 'piped',
      }).output();
      if (!check.success || !new TextDecoder().decode(check.stdout).includes('_NET_WM_STATE_ABOVE')) {
        throw new Error('Native inference window is not above other windows in the Linux window manager.');
      }
    } else if (!child.isAlwaysOnTop()) throw new Error(`Native inference window ${child.windowId} is not always on top.`);
    await waitFor(child, `document.documentElement.dataset.theme === 'nord'`, 'Native inference page did not load its requested theme.');
    await evaluate(`document.documentElement.dataset.theme = 'dracula'; true`);
    await inference.bindings.mcmSetInferenceTheme('dracula');
    await waitFor(child, `document.documentElement.dataset.theme === 'dracula'`, 'Native inference did not receive a live theme update.');
    await inference.bindings.mcmOpenInference({ width: 310, height: 330, theme: 'dracula' });
    if (inference.nativeWindow !== child) throw new Error('Repeated inference open created a duplicate window.');
    child.dispatchEvent(new Event('close', { cancelable: true }));
    if (!child.isClosed()) throw new Error('Inference close handler did not close the native window.');
    await waitFor(window, `document.documentElement.dataset.mcmSmokeInferenceState === 'false'`, 'Child close did not restore the main window state.');
    if (window.isClosed() || (await inference.bindings.mcmInferenceState()).open) throw new Error('Closing inference affected the main window or retained stale state.');
    if ((await fetch(`${desktopNativeOrigin(Deno.env.toObject())}/api/bootstrap`)).status !== 200) throw new Error('Closing inference stopped the backend.');
    await evaluate(`document.documentElement.dataset.theme = 'monokai'; true`);
    await inference.bindings.mcmOpenInference({ width: 300, height: 320, theme: 'monokai' });
    const reopened = inference.nativeWindow;
    if (!reopened || reopened === child) throw new Error('Inference did not reopen.');
    await waitFor(reopened, `!!document.querySelector('.native-inference-page .runtime-card')
      && document.documentElement.dataset.theme === 'monokai'`, 'Reopened inference did not render with the latest theme.');
    const event = new Event('close', { cancelable: true });
    window.dispatchEvent(event);
    if (!event.defaultPrevented) throw new Error('Native close did not wait for backend cleanup.');
    await shutdown();
    if (!reopened.isClosed()) throw new Error('Main shutdown left an orphan inference window.');
    console.log('Native WebView smoke passed: rendered MCM, same-origin API, native always-on-top inference, bridge, themes, reuse, close/reopen, asynchronous close and cleanup.');
  } catch (error) {
    console.error('Native WebView smoke failed:', error);
    await shutdown();
    Deno.exit(1);
  }
}
