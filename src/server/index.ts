import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { createApp } from './app';
import type { Interceptor } from './interceptors';

async function loadInterceptors(): Promise<Interceptor[]> {
  const modulePath = process.env.MCM_INTERCEPTOR_MODULE;
  if (!modulePath) return [];
  if (!isAbsolute(modulePath)) throw new Error('MCM_INTERCEPTOR_MODULE must be an absolute trusted local module path.');
  const module = await import(pathToFileURL(modulePath).href) as { default?: Interceptor | Interceptor[]; interceptors?: Interceptor[] };
  const exported = module.interceptors ?? module.default;
  const interceptors = Array.isArray(exported) ? exported : [exported];
  const hooks = ['beforeRequest', 'onRequest', 'onOutboundRequest', 'onRequestChunk', 'onRequestEnd', 'onResponse', 'onResponseChunk', 'onComplete', 'onError'] as const;
  if (interceptors.some(value => !value || typeof value !== 'object' ||
    hooks.some(key => value[key] !== undefined && typeof value[key] !== 'function'))) {
    throw new Error('Interceptor module must export an interceptors array or default-export Interceptor objects.');
  }
  return interceptors as Interceptor[];
}

async function main(): Promise<void> {
  const port = Number(process.env.MCM_PORT ?? 7838);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('MCM_PORT must be an integer from 1024 to 65535.');
  const runtime = await createApp({
    dataDir: resolve(process.env.MCM_DATA_DIR ?? '.mcm'),
    interceptors: await loadInterceptors(),
  });
  let vite: import('vite').ViteDevServer | undefined;
  if (process.env.NODE_ENV === 'production') {
    const client = resolve('dist/client');
    runtime.app.use(express.static(client));
    runtime.app.get('/{*path}', (_request, response) => { response.sendFile(resolve(client, 'index.html')); });
  } else {
    const { createServer } = await import('vite');
    vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
    runtime.app.use(vite.middlewares);
  }
  const server = runtime.app.listen(port, '127.0.0.1');
  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    server.close();
    try { await runtime.close(); }
    catch {
      console.error('MCM shutdown could not flush usage history. Check data-directory permissions and free space.');
      process.exitCode = 1;
    } finally {
      await vite?.close();
      server.closeAllConnections();
    }
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  server.once('error', () => {
    console.error('MCM could not bind its loopback port. Check MCM_PORT and whether another instance is running.');
    process.exitCode = 1;
    void shutdown();
  });
  server.once('listening', () => { console.log(`MCM listening at http://127.0.0.1:${port}`); });
}

main().catch(() => {
  console.error('MCM startup failed. Check local settings, data-directory permissions, and trusted interceptor module configuration.');
  process.exitCode = 1;
});
