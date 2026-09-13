import { createServer, type Server, type RequestListener } from 'node:http';
import { mkdir, rmdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApp, type AppOptions } from '../src/server/app';
import { loadInterceptorModule } from '../src/server/interceptor-pipeline';

export interface DesktopServerOptions extends AppOptions {
  ports: number[];
  interceptorModule?: string;
}

export async function startDesktopServer(options: DesktopServerOptions) {
  const client = fileURLToPath(new URL('../dist/client/', import.meta.url));
  await access(join(client, 'index.html')).catch(() => {
    throw new Error('MCM frontend is missing. Run npm run build before building or launching desktop.');
  });
  const servers: Server[] = [];
  let runtime: Awaited<ReturnType<typeof createApp>> | undefined;
  let handler: RequestListener = (_request, response) => {
    response.writeHead(503); response.end('MCM is starting or shutting down.');
  };
  const unavailable = handler;
  const lock = join(options.dataDir, '.desktop-lock');
  let locked = false;
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    return closing ??= (async () => {
      handler = unavailable;
      const stopped = servers.map(server => new Promise<void>(resolve => { server.close(() => resolve()); }));
      try { await runtime?.close(); }
      finally {
        servers.forEach(server => server.closeAllConnections());
        await Promise.all(stopped);
        if (locked) await rmdir(lock);
      }
    })();
  }
  try {
    // Reserve every listener before touching persisted state; never adopt another backend.
    for (const port of options.ports) {
      const server = createServer((request, response) => handler(request, response));
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => reject(new Error(`MCM cannot listen on 127.0.0.1:${port}. Close the other instance or change MCM_PORT.`, { cause: error }));
        server.once('error', failed);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', failed);
          const address = server.address();
          if (port && address && typeof address === 'object' && address.port !== port) {
            reject(new Error(`MCM listener was unexpectedly remapped from ${port} to ${address.port}.`));
          } else resolve();
        });
      });
    }
    await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
    await mkdir(lock, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') throw new Error(`MCM data is locked: ${lock}. Close the other desktop instance. After a crash, remove this empty directory only after verifying MCM and its managed llama-server are stopped.`);
      throw error;
    });
    locked = true;
    runtime = await createApp({
      ...options,
      interceptors: options.interceptorModule ? await loadInterceptorModule(options.interceptorModule) : options.interceptors,
    });
    runtime.app.use(express.static(client));
    runtime.app.get('/{*path}', (_request, response) => { response.sendFile(join(client, 'index.html')); });
    handler = runtime.app;
    return { runtime, servers, close };
  } catch (error) {
    await close();
    throw error;
  }
}
