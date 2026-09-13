import { homedir } from 'node:os';
import { desktopDataDir, desktopPorts } from './options.ts';
import { startDesktopServer } from './server.ts';

let backend: Awaited<ReturnType<typeof startDesktopServer>> | undefined;
let window: Deno.BrowserWindow | undefined;
let shutdownTask: Promise<void> | undefined;
let mayClose = false;

function shutdown(): Promise<void> {
  return shutdownTask ??= (async () => {
    let failed = false;
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
function onSignal(): void { void ready.then(shutdown, shutdown); }

try {
  if (!Deno.env.get('DENO_SERVE_ADDRESS')) throw new Error('Use npm run desktop or the packaged MCM launcher for a native window.');
  window = new Deno.BrowserWindow({ title: 'MCM — Model Config Manager', width: 1280, height: 900 });
  window.addEventListener('close', event => {
    if (mayClose) return;
    event.preventDefault();
    // Startup can still be acquiring resources when the user closes the window.
    void ready.then(shutdown, shutdown);
  });
} catch (error) {
  console.error('MCM desktop startup failed:', error);
  Deno.exit(1);
}
Deno.addSignalListener('SIGINT', onSignal);
if (Deno.build.os !== 'windows') Deno.addSignalListener('SIGTERM', onSignal);
const ready = (async () => {
  const env = Deno.env.toObject();
  backend = await startDesktopServer({
    dataDir: desktopDataDir(Deno.build.os === 'windows' ? 'win32' : Deno.build.os, env, homedir()),
    // Deno remaps the first Node HTTP listener to its native address once.
    ports: desktopPorts(env).toReversed(),
    interceptorModule: env.MCM_INTERCEPTOR_MODULE,
  });
  console.log(`MCM desktop ready; API http://127.0.0.1:${desktopPorts(env)[0]}`);
})().catch(async error => {
  console.error('MCM desktop startup failed:', error);
  // Deno desktop's native error reporter displays uncaught failures, including in GUI launches.
  await shutdown();
  throw error;
});
await ready;
if (Deno.env.get('MCM_DESKTOP_SMOKE') === '1') {
  try {
    const evaluate = async (script: string): Promise<unknown> => {
      const result = await window.executeJs(script);
      // Laufey WebView 0.7 returns a result envelope, unlike the CEF backend.
      if (result && typeof result === 'object' && 'ok' in result) {
        if (!result.ok) throw new Error('Native JavaScript evaluation failed.');
        return 'value' in result ? result.value : undefined;
      }
      return result;
    };
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
    const event = new Event('close', { cancelable: true });
    window.dispatchEvent(event);
    if (!event.defaultPrevented) throw new Error('Native close did not wait for backend cleanup.');
    await shutdown();
    console.log('Native WebView smoke passed: rendered MCM, same-origin API, asynchronous close and cleanup.');
  } catch (error) {
    console.error('Native WebView smoke failed:', error);
    await shutdown();
    Deno.exit(1);
  }
}
