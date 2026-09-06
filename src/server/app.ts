import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { z } from 'zod';
import { repoSchema } from '../shared/config';
import { ApiError } from './errors';
import { Store } from './storage';
import { Events } from './events';
import { ProcessManager, discoverCapabilities, type ProcessOptions } from './process';
import { discoverModels } from './models';
import { HuggingFace, type HubOptions } from './huggingface';
import { ThroughputInterceptor, type Interceptor } from './interceptors';
import { ProxyService } from './proxy';

export interface AppOptions {
  dataDir: string;
  interceptors?: Interceptor[];
  process?: ProcessOptions;
  hub?: HubOptions;
  metricsFetch?: typeof fetch;
  metricsPollMs?: number;
}

const hostGuard: RequestHandler = (request, response, next) => {
  const host = request.headers.host;
  if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host)) {
    response.status(403).json({ error: 'MCM accepts only localhost requests.' });
    return;
  }
  next();
};

const guard: RequestHandler = (request, response, next) => {
  const host = request.headers.host;
  const origin = request.headers.origin;
  if ((origin && origin !== `${request.protocol}://${host}`) ||
    request.headers['sec-fetch-site'] === 'cross-site') {
    response.status(403).json({ error: 'Cross-origin requests are not permitted.' });
    return;
  }
  next();
};

const proxyMethods = ['GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'HEAD'];
const proxyCors: RequestHandler = (request, response, next) => {
  if (request.headers.origin) {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Expose-Headers', '*');
  }
  if (request.method !== 'OPTIONS') { next(); return; }

  response.vary('Access-Control-Request-Method');
  response.vary('Access-Control-Request-Headers');
  const method = request.get('Access-Control-Request-Method');
  if (method && !proxyMethods.includes(method)) {
    response.status(405).json({ error: 'Unsupported proxy method.' });
    return;
  }
  const headers = request.get('Access-Control-Request-Headers');
  if (headers && !headers.split(',').every(header => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header.trim()))) {
    response.status(400).json({ error: 'Invalid preflight request headers.' });
    return;
  }
  response.setHeader('Access-Control-Allow-Methods', proxyMethods.join(', '));
  if (headers) response.setHeader('Access-Control-Allow-Headers', headers);
  response.setHeader('Access-Control-Max-Age', '600');
  response.status(204).end();
};

const modelRequest = z.object({ modelId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/) }).strict();
const hubRequest = z.object({ repo: repoSchema.optional() }).strict();
const noBody = z.object({}).strict();

export async function createApp(options: AppOptions) {
  const store = new Store(options.dataDir);
  await store.init();
  const events = new Events(text => store.redact(text));
  const manager = new ProcessManager(store, events, options.process);
  const upstream = (): string => {
    const settings = store.getSettings();
    return settings.upstreamUrl || `http://127.0.0.1:${manager.getManagedPort() ?? settings.serverPort}`;
  };
  const throughput = new ThroughputInterceptor(events, upstream, options.metricsFetch, options.metricsPollMs);
  const proxy = new ProxyService(upstream, [throughput, ...options.interceptors ?? []], events);
  const hub = new HuggingFace(store, options.hub);
  const app = express();
  app.disable('x-powered-by');
  app.use(hostGuard);
  app.use((request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  // Proxy precedes body parsing so uploads and SSE never require whole-body buffering.
  app.use('/v1', proxyCors, (request, response) => {
    if (!proxyMethods.includes(request.method)) {
      response.status(405).json({ error: 'Unsupported proxy method.' }); return;
    }
    // Express mount trims request.url; ProxyService uses the original URL for routing.
    return proxy.handle(request, response);
  });
  app.use(guard);
  app.use('/api', express.json({ limit: '2mb', strict: true }));
  app.get('/api/bootstrap', (_request, response) => {
    response.json({ workspace: store.getWorkspace(), settings: store.publicSettings(), status: manager.getStatus() });
  });
  app.put('/api/workspace', async (request, response) => { response.json(await store.saveWorkspace(request.body)); });
  app.put('/api/settings', async (request, response) => { response.json(await store.saveSettings(request.body)); });
  app.get('/api/models', async (_request, response) => {
    response.json({ models: await discoverModels(store.getSettings().modelsDirectory) });
  });
  app.post('/api/capabilities', async (request, response) => {
    noBody.parse(request.body ?? {});
    response.json(await discoverCapabilities(store.getSettings(), options.process?.helpTimeoutMs));
  });
  app.post('/api/preview', async (request, response) => {
    response.json(await manager.preview(modelRequest.parse(request.body).modelId));
  });
  app.post('/api/launch', async (request, response) => {
    response.json(await manager.launch(modelRequest.parse(request.body).modelId));
  });
  app.post('/api/stop', async (request, response) => {
    noBody.parse(request.body ?? {});
    response.json(await manager.stop());
  });
  app.post('/api/restart', async (request, response) => {
    noBody.parse(request.body ?? {});
    response.json(await manager.restart());
  });
  app.get('/api/events', (request, response) => {
    events.connect(response, manager.getStatus(), request.get('Last-Event-ID'));
  });
  app.post('/api/hf/push', async (request, response) => {
    response.json(await hub.push(hubRequest.parse(request.body ?? {}).repo));
  });
  app.post('/api/hf/pull', async (request, response) => {
    response.json(await hub.pull(hubRequest.parse(request.body ?? {}).repo));
  });
  app.use('/api', (_request, response) => { response.status(404).json({ error: 'API endpoint not found.' }); });
  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (response.headersSent) { response.destroy(); return; }
    if (error instanceof z.ZodError) {
      response.status(400).json({ error: store.redact(error.issues.map(issue => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ')) });
    } else if (error instanceof ApiError) response.status(error.status).json({ error: store.redact(error.message) });
    else if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') {
      response.status(413).json({ error: 'Request body exceeds the 2 MiB limit.' });
    } else if (error instanceof SyntaxError) response.status(400).json({ error: 'Invalid JSON request body.' });
    else {
      events.log('An internal operation failed. Check local filesystem permissions and settings.');
      response.status(500).json({ error: 'Internal operation failed. Check local filesystem permissions and settings.' });
    }
  };
  app.use(errorHandler);
  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    proxy.close();
    throughput.close();
    await manager.close();
    events.close();
  }
  return { app, store, manager, events, close };
}
