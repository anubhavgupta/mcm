import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type RequestListener, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createApp } from './app';
import { emptyWorkspace } from '../shared/config';
import type { CustomInterceptorEntry, InterceptorPipeline } from '../shared/types';
import type { Interceptor } from './interceptors';

let directory: string;
let runtime: Awaited<ReturnType<typeof createApp>>;
const servers: Server[] = [];
beforeEach(async () => {
  directory = resolve(`src/server/.test-data-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
});
afterEach(async () => {
  await runtime?.close();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
  await rm(directory, { recursive: true, force: true });
});
async function listen(listener: RequestListener): Promise<string> {
  const server = createServer(listener);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function app(upstream?: string, interceptors?: Interceptor[]): Promise<string> {
  runtime = await createApp({ dataDir: directory, interceptors, metricsPollMs: 10000 });
  if (upstream) await runtime.store.saveSettings({ upstreamUrl: upstream });
  return listen(runtime.app);
}
async function entry(name: string): Promise<CustomInterceptorEntry> {
  const modulePath = join(directory, `${name}.mjs`);
  await writeFile(modulePath, `
    import { appendFileSync } from 'node:fs';
    const log = (context, hook) => appendFileSync(${JSON.stringify(join(directory, 'calls.jsonl'))},
      JSON.stringify({ requestId: context.requestId, name: ${JSON.stringify(name)}, hook }) + '\\n');
    export default {
      onRequest(context) { return log(context, 'onRequest'); },
      async beforeRequest(context, outbound) {
        outbound.headers['x-sequence'] = (outbound.headers['x-sequence'] ?? '') + ${JSON.stringify(name)};
        outbound.headers['x-test-request-id'] = context.requestId;
        const body = JSON.parse(outbound.body ?? Buffer.from(await outbound.readBody()).toString());
        const field = context.protocol === 'anthropic' ? 'system' : 'sequence';
        body[field] = (body[field] ?? '') + ${JSON.stringify(name)};
        outbound.body = JSON.stringify(body);
        await log(context, 'beforeRequest');
      },
      onOutboundRequest(context) { return log(context, 'onOutboundRequest'); },
      onRequestChunk(context) { return log(context, 'onRequestChunk'); },
      onRequestEnd(context) { return log(context, 'onRequestEnd'); },
      onResponse(context) { return log(context, 'onResponse'); },
      onResponseChunk(context) { return log(context, 'onResponseChunk'); },
      onComplete(context) { return log(context, 'onComplete'); },
      onError(context) { return log(context, 'onError'); },
    };
  `);
  return { id: `custom-${name}`, name, modulePath };
}
async function calls(): Promise<{ requestId: string; name: string; hook: string }[]> {
  return (await readFile(join(directory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}
function save(base: string, entries: CustomInterceptorEntry[], extra: object = {}): Promise<Response> {
  return fetch(`${base}/api/interceptors`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries, trustedCodeAcknowledged: true, ...extra }) });
}
const completion = {
  id: 'chat-test', object: 'chat.completion', model: 'test-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  timings: { prompt_n: 10, predicted_n: 5, prompt_per_second: 100, predicted_per_second: 20 },
};
function respond(response: ServerResponse): void {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(completion));
}
const requestBody = { model: 'test-model', messages: [{ role: 'user', content: 'Hello' }], max_tokens: 10 };
async function inference(base: string, headers: Record<string, string> = {}, path = '/v1/chat/completions') {
  return fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(requestBody) });
}

describe('interceptor management and live proxy sequencing', () => {
  it('protects management operations, refuses locked changes, and keeps local paths out of shared data', async () => {
    const base = await app(undefined, [{ onRequest() {} }]);
    const a = await entry('A');
    const blockedHeaders: Record<string, string>[] = [{ Origin: 'https://remote.example' }, { 'Sec-Fetch-Site': 'cross-site' }];
    for (const headers of blockedHeaders) {
      for (const method of ['GET', 'PUT']) {
        expect((await fetch(`${base}/api/interceptors`, { method, headers })).status).toBe(403);
      }
    }
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${base}/api/interceptors`, { method: 'PUT', headers: { Host: 'remote.example' } }, response => {
        response.resume(); resolve(response.statusCode);
      });
      request.once('error', reject); request.end();
    });
    expect(status).toBe(403);
    expect((await save(base, [a], { trustedCodeAcknowledged: false })).status).toBe(400);
    for (const id of ['builtin-telemetry', 'environment-interceptors']) {
      expect((await save(base, [{ ...a, id }])).status).toBe(400);
    }
    expect((await save(base, [a], { enabled: false })).status).toBe(400);
    expect((await fetch(`${base}/api/interceptors/builtin-telemetry`, { method: 'DELETE' })).status).toBe(404);
    expect((await save(base, [a])).status).toBe(200);
    const pipeline = await (await fetch(`${base}/api/interceptors`)).json() as InterceptorPipeline;
    expect(pipeline.entries.map(item => item.source)).toEqual(['builtin', 'environment', 'local']);
    expect(pipeline.entries.slice(0, 2).every(item => item.locked && !('modulePath' in item))).toBe(true);
    expect(await (await fetch(`${base}/api/bootstrap`)).text()).not.toContain(a.modulePath);
    expect(await readFile(join(directory, 'workspace.json'), 'utf8')).not.toContain(a.modulePath);
    expect(await readFile(join(directory, 'settings.json'), 'utf8')).not.toContain(a.modulePath);
    expect((await save(base, [])).status).toBe(200);
    const remaining = await (await fetch(`${base}/api/interceptors`)).json() as InterceptorPipeline;
    expect(remaining.entries.map(item => item.id)).toEqual(['builtin-telemetry', 'environment-interceptors']);
  });

  it('changes beforeRequest header/body effects and hook order, persists across reopen, and preserves telemetry, CORS and translation', async () => {
    const received: { sequence: string | undefined; body: Record<string, unknown>; path: string | undefined }[] = [];
    const upstream = await listen(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received.push({ sequence: request.headers['x-sequence'] as string | undefined, body: JSON.parse(Buffer.concat(chunks).toString()), path: request.url });
      respond(response);
    });
    let base = await app(upstream);
    await runtime.store.saveWorkspace({ ...emptyWorkspace(), base: { inputUsdPerMillion: 2, outputUsdPerMillion: 4 } });
    const emit = vi.spyOn(runtime.events, 'emit');
    const a = await entry('A');
    const b = await entry('B');
    expect((await save(base, [a, b])).status).toBe(200);
    const first = await inference(base, { Origin: 'https://client.example' });
    expect(first.status).toBe(200);
    expect(first.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await first.json()).toEqual(completion);
    await vi.waitFor(() => expect(runtime.usage.getSummary().session.requestCount).toBe(1));
    expect(received[0]).toMatchObject({ sequence: 'AB', body: { sequence: 'AB' } });
    expect((await calls()).filter(call => call.hook === 'beforeRequest').map(call => call.name)).toEqual(['A', 'B']);
    expect(emit.mock.calls.some(([event]) => event.type === 'throughput' &&
      event.data.pp === 100 && event.data.tg === 20 && !event.data.active)).toBe(true);
    expect(runtime.usage.getSummary().session).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(runtime.usage.getSummary().session.costUsd).toBeCloseTo(0.00004, 10);

    expect((await save(base, [b, a])).status).toBe(200);
    await (await inference(base)).json();
    expect(received[1]).toMatchObject({ sequence: 'BA', body: { sequence: 'BA' } });
    await vi.waitFor(() => expect(runtime.usage.getSummary().session.requestCount).toBe(2));
    await runtime.close();
    base = await app();
    expect((await (await fetch(`${base}/api/interceptors`)).json()).entries.map((item: { id: string }) => item.id))
      .toEqual(['builtin-telemetry', 'custom-B', 'custom-A']);
    await runtime.store.saveSettings({ anthropicMode: 'openai' });
    const translated = await inference(base, { Origin: 'https://client.example' }, '/v1/messages');
    expect(translated.status).toBe(200);
    expect(translated.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await translated.json()).toMatchObject({ type: 'message', usage: { input_tokens: 10, output_tokens: 5 } });
    expect(received[2]).toMatchObject({ sequence: 'BA', path: '/v1/chat/completions' });
    await vi.waitFor(() => expect(runtime.usage.getSummary().allTime.requestCount).toBe(3));
    expect((await save(base, [])).status).toBe(200);
    await (await inference(base, {}, '/v1/messages')).json();
    await vi.waitFor(() => expect(runtime.usage.getSummary().allTime.requestCount).toBe(4));
    expect(runtime.usage.getSummary().allTime).toMatchObject({ inputTokens: 40, outputTokens: 20 });
    expect(runtime.usage.getSummary().allTime.costUsd).toBeCloseTo(0.00016, 10);
    expect(received[3]?.sequence).toBeUndefined();
  });

  it.each(['reorder', 'remove'] as const)('snapshots every hook for in-flight requests during %s', async operation => {
    const held: { response: ServerResponse; requestId: string }[] = [];
    const upstream = await listen(async (request, response) => {
      for await (const _chunk of request) { /* Drain the request before delaying the response. */ }
      held.push({ response, requestId: String(request.headers['x-test-request-id']) });
    });
    const base = await app(upstream);
    const a = await entry('A');
    const b = await entry('B');
    await save(base, [a, b]);
    const first = inference(base);
    await vi.waitFor(() => expect(held).toHaveLength(1));
    await save(base, operation === 'reorder' ? [b, a] : [b]);
    const second = inference(base);
    await vi.waitFor(() => expect(held).toHaveLength(2));
    respond(held[1]!.response);
    await (await second).json();
    respond(held[0]!.response);
    await (await first).json();
    await vi.waitFor(async () => expect((await calls()).filter(call => call.hook === 'onComplete')).toHaveLength(operation === 'reorder' ? 4 : 3));
    const log = await calls();
    for (const hook of ['onRequest', 'beforeRequest', 'onOutboundRequest', 'onRequestEnd', 'onResponse', 'onComplete']) {
      expect(log.filter(call => call.requestId === held[0]!.requestId && call.hook === hook).map(call => call.name)).toEqual(['A', 'B']);
      expect(log.filter(call => call.requestId === held[1]!.requestId && call.hook === hook).map(call => call.name)).toEqual(operation === 'reorder' ? ['B', 'A'] : ['B']);
    }
    expect(runtime.usage.getSummary().session).toMatchObject({ requestCount: 2, inputTokens: 20, outputTokens: 10 });
  });

  it('retains removed interceptors for in-flight error hooks and keeps a failed update from activating', async () => {
    let held: ServerResponse | undefined;
    const upstream = await listen(async (request, response) => {
      for await (const _chunk of request) { /* Wait for the upload to finish. */ }
      held = response;
    });
    const base = await app(upstream);
    const a = await entry('A');
    await save(base, [a]);
    const pending = inference(base);
    await vi.waitFor(() => expect(held).toBeDefined());
    const failed = await save(base, [{ ...a, modulePath: join(directory, 'missing.mjs') }]);
    expect(failed.status).toBe(400);
    expect((await (await fetch(`${base}/api/interceptors`)).json()).entries.at(-1).modulePath).toBe(a.modulePath);
    await save(base, []);
    held!.destroy();
    expect((await pending).status).toBe(502);
    await vi.waitFor(async () => expect((await calls()).filter(call => call.hook === 'onError').map(call => call.name)).toEqual(['A']));
    await vi.waitFor(() => expect(runtime.usage.getSummary().session.requestCount).toBe(1));
    expect(runtime.usage.getSummary().session.missingUsageRequests).toBe(1);
  });
});
