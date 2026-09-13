import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, request as httpRequest, type Server, type RequestListener } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createApp } from './app';
import { emptyWorkspace } from '../shared/config';
import { filteredHeaders } from './proxy';
import type { Interceptor } from './interceptors';

let directory: string;
let runtime: Awaited<ReturnType<typeof createApp>> | undefined;
const servers: Server[] = [];
async function listen(listener: RequestListener): Promise<string> {
  const server = createServer(listener);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function app(upstream?: string, interceptors?: Interceptor[]) {
  runtime = await createApp({ dataDir: directory, interceptors, metricsPollMs: 10000 });
  if (upstream) await runtime.store.saveSettings({ upstreamUrl: upstream, hfToken: 'hf_machine_secret' });
  return listen(runtime.app);
}
beforeEach(() => { directory = resolve(`src/server/.test-data-${randomUUID()}`); });
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
  await rm(directory, { recursive: true, force: true });
});

describe('management API validation and privacy', () => {
  async function versionFixture(version: string): Promise<string> {
    const path = join(directory, `binary-${randomUUID()}.mjs`);
    await writeFile(path, `#!${process.execPath}\nconsole.log(process.argv.includes('--version') ? ${JSON.stringify(`version: ${version}`)} : '--model --host --port --threads');`);
    await chmod(path, 0o700);
    return path;
  }
  it('probes an unsaved executable without changing settings or workspace', async () => {
    const base = await app();
    const path = await versionFixture('12345 (abcdef)');
    await runtime!.store.saveSettings({ executablePath: '/saved/path', executableOverrides: { base: '/other/path' } });
    const settingsBefore = await readFile(join(directory, 'settings.json'), 'utf8');
    const workspaceBefore = await readFile(join(directory, 'workspace.json'), 'utf8');
    const response = await fetch(`${base}/api/version`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ executablePath: path }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ executablePath: path, version: '12345 (abcdef)' });
    expect(await readFile(join(directory, 'settings.json'), 'utf8')).toBe(settingsBefore);
    expect(await readFile(join(directory, 'workspace.json'), 'utf8')).toBe(workspaceBefore);
    for (const body of [{}, { executablePath: 'relative' }, { executablePath: '' }, { executablePath: '/bad\npath' },
      { executablePath: '/bad\x7fpath' }, { executablePath: '/'.repeat(4097) }, { executablePath: path, extra: true },
      { executablePath: join(directory, 'missing') }]) {
      const invalid = await fetch(`${base}/api/version`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toHaveProperty('error');
    }
  });
  it('probes the effective executable and expected version for each selected scope', async () => {
    const base = await app();
    const basePath = await versionFixture('1');
    const groupPath = await versionFixture('2');
    const modelPath = await versionFixture('3');
    await runtime!.store.saveWorkspace({
      ...emptyWorkspace(), llamaVersion: '1',
      groups: [{ id: 'group', name: 'Group', values: {}, llamaVersion: '2' }],
      models: [{ id: 'model', name: 'Model', groupId: 'group', model: { filename: 'model.gguf' }, values: {}, llamaVersion: '99' }],
    });
    await runtime!.store.saveSettings({ executablePath: '/missing', executableOverrides: { base: basePath, groups: { group: groupPath }, models: { model: modelPath } } });
    for (const [scope, version] of [[undefined, '1'], [{ kind: 'base' }, '1'], [{ kind: 'group', id: 'group' }, '2'], [{ kind: 'model', id: 'model' }, '3']] as const) {
      const response = await fetch(`${base}/api/capabilities`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: scope ? JSON.stringify({ scope }) : undefined,
      });
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.version).toBe(version);
      expect(result.flags).toContain('--threads');
      if (version === '3') expect(result.compatibilityWarning).toContain('99');
      else expect(result.compatibilityWarning).toBeUndefined();
    }
    for (const kind of ['model', 'group']) {
      expect((await fetch(`${base}/api/capabilities`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: { kind, id: 'missing' } }),
      })).status).toBe(404);
    }
    for (const scope of [{ kind: 'machine' }, { kind: 'base', id: 'unexpected' }, { kind: 'model' }]) {
      expect((await fetch(`${base}/api/capabilities`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope }),
      })).status).toBe(400);
    }
  });
  it('applies management host and origin guards to version execution', async () => {
    const base = await app();
    for (const headers of [{ Origin: 'https://attacker.example' }, { 'Sec-Fetch-Site': 'cross-site' }] as Record<string, string>[]) {
      expect((await fetch(`${base}/api/version`, { method: 'POST', headers })).status).toBe(403);
    }
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${base}/api/version`, { method: 'POST', headers: { Host: 'remote.example' } }, response => {
        response.resume();
        resolve(response.statusCode);
      });
      request.once('error', reject);
      request.end();
    });
    expect(status).toBe(403);
  });
  it('validates input consistently, saves workspace and never exposes tokens', async () => {
    const base = await app();
    let response = await fetch(`${base}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hfToken: 'hf_private' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ hfTokenConfigured: true });
    expect(await (await fetch(`${base}/api/bootstrap`)).text()).not.toContain('hf_private');
    response = await fetch(`${base}/api/workspace`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(emptyWorkspace()) });
    expect(await response.json()).toEqual(emptyWorkspace());
    for (const body of ['{"version":2}', '{oops']) {
      response = await fetch(`${base}/api/workspace`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
      expect(response.status).toBe(400);
      expect(await response.json()).toHaveProperty('error');
    }
    response = await fetch(`${base}/api/models`);
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty('error');
    response = await fetch(`${base}/api/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"modelId":"nope","executable":"/bad"}' });
    expect(response.status).toBe(400);
  });
  it('rejects DNS rebinding and browser cross-origin access without restricting programmatic clients', async () => {
    const base = await app();
    const invalidHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${base}/api/bootstrap`, { headers: { Host: 'attacker.example' } }, response => {
        response.resume();
        resolve(response.statusCode);
      });
      request.once('error', reject);
      request.end();
    });
    expect(invalidHostStatus).toBe(403);
    expect((await fetch(`${base}/api/stop`, { method: 'POST', headers: { Origin: 'https://attacker.example' } })).status).toBe(403);
    expect((await fetch(`${base}/api/bootstrap`, { headers: { Origin: 'null' } })).status).toBe(403);
    expect((await fetch(`${base}/api/bootstrap`, { headers: { Origin: base.replace('http:', 'https:') } })).status).toBe(403);
    expect((await fetch(`${base}/api/bootstrap`, { headers: { Origin: base } })).status).toBe(200);
    expect((await fetch(`${base}/api/stop`, { method: 'POST' })).status).toBe(200);
  });
  it('replays events, redacts secrets, and streams initial status', async () => {
    const base = await app();
    await runtime!.store.saveSettings({ hfToken: 'hf_secret' });
    runtime!.events.log('test hf_secret private');
    runtime!.events.log('second entry');
    const controller = new AbortController();
    const response = await fetch(`${base}/api/events`, { signal: controller.signal, headers: { 'Last-Event-ID': '1' } });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const text = new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain('second entry');
    expect(text).not.toContain('hf_secret');
    expect(text).not.toContain('test');
    expect(text).toContain('"phase":"stopped"');
    controller.abort();
    await reader.cancel().catch(() => {});
  });
});

describe('streaming protocol passthrough', () => {
  it.each(['host.docker.internal:7838', 'mcm:7838', '192.168.1.10:7838'])('accepts container-facing Host %s on Anthropic proxy requests', async host => {
    let forwardedHost: string | undefined;
    let forwardedVersion: string | undefined;
    const upstream = await listen(async (request, response) => {
      forwardedHost = request.headers.host;
      forwardedVersion = request.headers['anthropic-version'] as string | undefined;
      for await (const _chunk of request) { /* Drain request before sending the response. */ }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
    const base = await app(upstream);
    const result = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const request = httpRequest(`${base}/v1/messages`, {
        method: 'POST', headers: { Host: host, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
      }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.once('error', reject);
        response.once('end', () => resolve({ status: response.statusCode, body }));
      });
      request.once('error', reject);
      request.end('{"messages":[],"stream":true}');
    });
    expect(result).toEqual({ status: 200, body: 'event: message_stop\ndata: {"type":"message_stop"}\n\n' });
    expect(forwardedHost).toBe(new URL(upstream).host);
    expect(forwardedVersion).toBe('2023-06-01');
  });
  it('permits container-host preflight only on the inference proxy, not management routes', async () => {
    const base = await app();
    for (const path of ['/v1/messages', '/api/settings', '/api/launch', '/api/usage', '/v10/messages', '/']) {
      const result = await new Promise<{ status: number | undefined; origin: string | undefined }>((resolve, reject) => {
        const request = httpRequest(`${base}${path}`, {
          method: 'OPTIONS', headers: {
            Host: 'host.docker.internal:7838', Origin: 'http://client.example',
            'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-api-key',
          },
        }, response => {
          response.resume();
          resolve({ status: response.statusCode, origin: response.headers['access-control-allow-origin'] as string | undefined });
        });
        request.once('error', reject);
        request.end();
      });
      expect(result).toEqual(path === '/v1/messages' ? { status: 204, origin: '*' } : { status: 403, origin: undefined });
    }
  });
  it('handles cross-origin preflight locally with OpenAI and Anthropic client headers', async () => {
    const upstreamCalls = vi.fn();
    const upstream = await listen((_request, response) => { upstreamCalls(); response.end(); });
    const base = await app(upstream);
    for (const path of ['/v1/chat/completions', '/v1/messages']) {
      const headers = 'content-type, authorization, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access';
      const response = await fetch(`${base}${path}`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:3000', 'Sec-Fetch-Site': 'cross-site',
          'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': headers,
        },
      });
      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('access-control-allow-methods')).toContain('POST');
      expect(response.headers.get('access-control-allow-headers')).toBe(headers);
      expect(response.headers.get('access-control-allow-credentials')).toBeNull();
      expect(response.headers.get('vary')).toContain('Access-Control-Request-Headers');
    }
    expect(upstreamCalls).not.toHaveBeenCalled();
  });
  it.each(['/v1/chat/completions', '/v1/messages'])('allows cross-origin streaming at %s without trusting upstream CORS', async path => {
    const upstream = await listen((_request, response) => {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Access-Control-Allow-Origin': 'https://other.example',
        'Access-Control-Allow-Credentials': 'true',
      });
      response.end('data: {"text":"hello"}\n\ndata: [DONE]\n\n');
    });
    const base = await app(upstream);
    const response = await fetch(`${base}${path}`, {
      method: 'POST', headers: { Origin: 'https://client.example', 'Sec-Fetch-Site': 'cross-site' }, body: '{}',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    expect(await response.text()).toContain('data: [DONE]');
  });
  it('includes CORS on proxy errors but keeps management endpoints protected', async () => {
    const base = await app('http://127.0.0.1:1');
    const headers = { Origin: 'http://localhost:3000' };
    const failed = await fetch(`${base}/v1/messages`, { method: 'POST', headers, body: '{}' });
    expect(failed.status).toBe(502);
    expect(failed.headers.get('access-control-allow-origin')).toBe('*');
    for (const path of ['/api/settings', '/api/launch', '/api/bootstrap', '/v10/messages']) {
      for (const method of ['OPTIONS', 'POST']) {
        const response = await fetch(`${base}${path}`, { method, headers });
        expect(response.status).toBe(403);
        expect(response.headers.get('access-control-allow-origin')).toBeNull();
      }
    }
    const unsupported = await fetch(`${base}/v1/messages`, {
      method: 'OPTIONS', headers: { ...headers, 'Access-Control-Request-Method': 'TRACE' },
    });
    expect(unsupported.status).toBe(405);
  });
  it('strips standard and connection-nominated hop headers', () => {
    expect(filteredHeaders({ connection: 'keep-alive, x-private', 'x-private': 'remove', 'keep-alive': 'timeout=1', authorization: 'Bearer user', 'anthropic-version': '2023-06-01', 'x-keep': 'yes' }))
      .toEqual({ authorization: 'Bearer user', 'anthropic-version': '2023-06-01', 'x-keep': 'yes' });
  });
  it.each(['/v1/chat/completions', '/v1/messages'])('preserves %s JSON bytes, query, status, headers and client auth', async path => {
    const observed: { path?: string; body?: string; auth?: string; version?: string } = {};
    const upstream = await listen(async (request, response) => {
      observed.path = request.url;
      observed.auth = request.headers.authorization;
      observed.version = String(request.headers['anthropic-version']);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      observed.body = Buffer.concat(chunks).toString();
      response.writeHead(429, { 'Content-Type': 'application/json', 'X-Upstream': 'preserved', 'Access-Control-Allow-Origin': '*', Connection: 'x-hidden', 'X-Hidden': 'no' });
      response.end('{"error":{"message":"overloaded"}}');
    });
    const base = await app(upstream);
    const body = '{"messages":[{"role":"user","content":"test"}],"stream":false}';
    const response = await fetch(`${base}${path}?beta=true`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer client-key', 'anthropic-version': '2023-06-01' }, body,
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('x-upstream')).toBe('preserved');
    expect(response.headers.get('x-hidden')).toBeNull();
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(await response.text()).toBe('{"error":{"message":"overloaded"}}');
    expect(observed).toEqual({ path: `${path}?beta=true`, body, auth: 'Bearer client-key', version: '2023-06-01' });
    expect(JSON.stringify(observed)).not.toContain('hf_machine_secret');
  });
  it.each(['/v1/chat/completions', '/v1/messages'])('streams %s immediately with exact SSE bytes and custom observations', async path => {
    let finish!: () => void;
    const finishGate = new Promise<void>(resolve => { finish = resolve; });
    const first = 'event: message_start\ndata: {"text":"hello 😊"}\n\n';
    const last = 'data: {"timings":{"prompt_per_second":123,"predicted_per_second":45,"prompt_n":8,"predicted_n":4}}\n\ndata: [DONE]\n\n';
    const upstream = await listen(async (_request, response) => {
      response.writeHead(201, { 'Content-Type': 'text/event-stream', 'X-Test': 'stream' });
      response.write(first);
      await finishGate;
      const bytes = Buffer.from(last);
      for (const byte of bytes) response.write(Buffer.of(byte));
      response.end();
    });
    const seen: Uint8Array[] = [];
    const hook = vi.fn();
    const base = await app(upstream, [{
      onRequest: hook,
      onResponseChunk: (_context, chunk) => { seen.push(chunk.slice()); },
    }]);
    const events = vi.spyOn(runtime!.events, 'emit');
    const response = await fetch(`${base}${path}`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(201);
    const reader = response.body!.getReader();
    const firstChunk = (await reader.read()).value!;
    expect(Buffer.from(firstChunk).toString()).toBe(first);
    finish();
    const chunks = [firstChunk];
    while (true) { const next = await reader.read(); if (next.done) break; chunks.push(next.value); }
    expect(Buffer.concat(chunks).toString()).toBe(first + last);
    expect(Buffer.concat(seen).toString()).toBe(first + last);
    expect(hook.mock.calls[0]![0].protocol).toBe(path.endsWith('messages') ? 'anthropic' : 'openai');
    await vi.waitFor(() => expect(events.mock.calls.some(([event]) =>
      event.type === 'throughput' && event.data.tg === 45 && !event.data.active)).toBe(true));
  });
  it('cancels upstream when a streaming downstream disconnects', async () => {
    let cancelled = false;
    const upstream = await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: first\n\n');
      const timer = setInterval(() => response.write(': tick\n\n'), 20);
      response.once('close', () => { clearInterval(timer); cancelled = true; });
    });
    const base = await app(upstream);
    const controller = new AbortController();
    const response = await fetch(`${base}/v1/messages`, { method: 'POST', body: '{}', signal: controller.signal });
    await response.body!.getReader().read();
    controller.abort();
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });
  it('returns actionable 502 errors for an unavailable upstream', async () => {
    const base = await app('http://127.0.0.1:1');
    const response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(502);
    expect(await response.json()).toHaveProperty('error');
  });
  it('streams uploaded request bytes through observation hooks', async () => {
    let observed = '';
    const upstream = await listen(async (request, response) => {
      for await (const chunk of request) observed += chunk.toString();
      response.end('ok');
    });
    const hook = vi.fn();
    const base = await app(upstream, [{ onRequestChunk: hook }]);
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(`${base}/v1/messages`, { method: 'POST' }, response => {
        response.resume();
        response.once('end', resolve);
      });
      request.once('error', reject);
      request.write('first');
      request.end('second');
    });
    expect(observed).toBe('firstsecond');
    expect(hook).toHaveBeenCalled();
  });
  it.each(['/v1/chat/completions', '/v1/messages'])('reports %s upstream stream failure without translating partial bytes', async path => {
    const upstream = await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: first\n\n');
      setTimeout(() => response.destroy(), 40);
    });
    const failed = vi.fn();
    const base = await app(upstream, [{ onError: failed }]);
    const response = await fetch(`${base}${path}`, { method: 'POST', body: '{}' });
    const reader = response.body!.getReader();
    expect(Buffer.from((await reader.read()).value!).toString()).toBe('data: first\n\n');
    await expect(reader.read()).rejects.toThrow();
    await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
  });
  it('isolates broken or mutating observers from protocol bytes', async () => {
    let seen = '';
    const upstream = await listen(async (request, response) => {
      for await (const chunk of request) seen += chunk.toString();
      response.end('original');
    });
    const base = await app(upstream, [{
      onRequest: () => { throw new Error('sensitive custom detail'); },
      onRequestChunk: (_context, chunk) => { chunk.fill(0); },
      onResponseChunk: (_context, chunk) => { chunk.fill(0); },
    }]);
    const response = await fetch(`${base}/v1/messages`, { method: 'POST', body: 'request' });
    expect(await response.text()).toBe('original');
    expect(seen).toBe('request');
  });
  it('supports async custom header changes and bounded opt-in JSON request replacement', async () => {
    let seenBody = '';
    let seenHeader: string | undefined;
    let hiddenHeader: string | undefined;
    let length: string | undefined;
    const upstream = await listen(async (request, response) => {
      seenHeader = request.headers['x-custom'] as string | undefined;
      hiddenHeader = request.headers['x-hidden'] as string | undefined;
      length = request.headers['content-length'];
      for await (const chunk of request) seenBody += chunk.toString();
      response.setHeader('Content-Type', 'application/json');
      response.end('{"unchanged":true}');
    });
    const base = await app(upstream, [{
      beforeRequest: async (context, outbound) => {
        expect(context.protocol).toBe('anthropic');
        expect(context.signal.aborted).toBe(false);
        const body = JSON.parse(new TextDecoder().decode(await outbound.readBody())) as Record<string, unknown>;
        body.model = 'custom-selected-model';
        outbound.body = JSON.stringify(body);
        outbound.headers['X-Custom'] = 'interceptor-added';
        outbound.headers.connection = 'x-hidden';
        outbound.headers['X-Hidden'] = 'must-strip';
      },
    }]);
    const response = await fetch(`${base}/v1/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"model":"old","messages":[]}',
    });
    expect(await response.text()).toBe('{"unchanged":true}');
    expect(JSON.parse(seenBody)).toEqual({ model: 'custom-selected-model', messages: [] });
    expect(seenHeader).toBe('interceptor-added');
    expect(hiddenHeader).toBeUndefined();
    expect(Number(length)).toBe(Buffer.byteLength(seenBody));
  });
  it('replays exact request bytes when a hook reads the body without replacing it', async () => {
    let seen = '';
    const upstream = await listen(async (request, response) => {
      for await (const chunk of request) seen += chunk.toString();
      response.end('ok');
    });
    const base = await app(upstream, [{
      beforeRequest: async (_context, outbound) => {
        const read = await outbound.readBody();
        expect(Buffer.from(read).toString()).toBe('{ "a": 1 }\n');
        read.fill(0);
      },
    }]);
    expect((await fetch(`${base}/v1/messages`, { method: 'POST', body: '{ "a": 1 }\n' })).status).toBe(200);
    expect(seen).toBe('{ "a": 1 }\n');
  });
  it('fails closed when a modifying hook rejects instead of silently forwarding credentials', async () => {
    const upstreamRequest = vi.fn((_request, response) => { response.end('should not reach upstream'); });
    const upstream = await listen(upstreamRequest);
    const base = await app(upstream, [{ beforeRequest: () => { throw new Error('private policy failure'); } }]);
    const response = await fetch(`${base}/v1/messages`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).toContain('interceptor preparation failed');
    expect(body).not.toContain('private policy failure');
    expect(upstreamRequest).not.toHaveBeenCalled();
  });
  it('bounds explicit body reads without buffering default proxy traffic', async () => {
    const upstreamRequest = vi.fn((_request, response) => { response.end('should not reach upstream'); });
    const upstream = await listen(upstreamRequest);
    const base = await app(upstream, [{ beforeRequest: async (_context, outbound) => { await outbound.readBody(); } }]);
    const response = await fetch(`${base}/v1/messages`, { method: 'POST', body: 'x'.repeat(2 * 1024 * 1024 + 1) });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('2 MiB');
    expect(upstreamRequest).not.toHaveBeenCalled();
  });
  it('applies downstream backpressure instead of draining a large upstream into memory', async () => {
    let bytesWritten = 0;
    let closed = false;
    const upstream = await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      const chunk = Buffer.alloc(64 * 1024, 'x');
      const pump = (): void => {
        while (!closed && bytesWritten < 128 * 1024 * 1024) {
          bytesWritten += chunk.length;
          if (!response.write(chunk)) { response.once('drain', pump); return; }
        }
        if (!closed) response.end();
      };
      response.once('close', () => { closed = true; });
      pump();
    });
    const base = await app(upstream);
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(`${base}/v1/messages`, response => {
        response.pause();
        setTimeout(() => {
          try { expect(bytesWritten).toBeLessThan(128 * 1024 * 1024); }
          catch (error) { reject(error); }
          response.destroy();
          request.destroy();
          resolve();
        }, 100);
      });
      request.once('error', reject);
      request.end();
    });
    await vi.waitFor(() => expect(closed).toBe(true));
  });
});

describe('optional Anthropic protocol translation', () => {
  it('finishes successfully on DONE even if upstream keeps the HTTP connection open', async () => {
    let closed = false;
    const upstream = await listen(async (request, response) => {
      for await (const _chunk of request) { /* Drain body. */ }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"done"}}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\ndata: [DONE]\n\n');
      response.once('close', () => { closed = true; });
    });
    const base = await app(upstream);
    await runtime!.store.saveSettings({ anthropicMode: 'openai' });
    const response = await fetch(`${base}/v1/messages`, { method: 'POST',
      body: JSON.stringify({ model: 'local', max_tokens: 10, messages: [{ role: 'user', content: 'Hi' }], stream: true }) });
    const text = await response.text();
    expect(text).toContain('event: message_stop');
    await vi.waitFor(() => expect(closed).toBe(true));
    expect(runtime!.usage.getSummary().session).toMatchObject({ inputTokens: 3, outputTokens: 1, missingUsageRequests: 0 });
  });
      const body = { model: 'local', max_tokens: 256, messages: [{ role: 'user', content: 'Hi' }] };
      const jsonCompletion = { id: 'chat-1', model: 'local', choices: [{ message: { content: 'Hello 😊' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2 } };
      const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
      async function enabled(upstream: string, interceptors?: Interceptor[]) {
        const base = await app(upstream, interceptors);
        await runtime!.store.saveSettings({ anthropicMode: 'openai' });
        return base;
      }
      it('translates after trusted hooks, preserves original context/auth/query/CORS and prices the final outbound model', async () => {
        let observed: Record<string, unknown> = {};
        const upstream = await listen(async (request, response) => {
          let data = '';
          for await (const chunk of request) data += chunk;
          observed = { path: request.url, body: JSON.parse(data), auth: request.headers.authorization,
            key: request.headers['x-api-key'], host: request.headers.host, encoding: request.headers['accept-encoding'] };
          const output = JSON.stringify({ ...jsonCompletion, usage: { prompt_tokens: 1000000, completion_tokens: 1000000 } });
          response.writeHead(201, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(output),
            'Content-MD5': 'stale', ETag: '"stale"', 'X-Upstream': 'yes' });
          response.end(output);
        });
        const contexts: unknown[] = [];
        const raw: Uint8Array[] = [];
        const base = await enabled(upstream, [{
          beforeRequest: async (context, outbound) => {
            contexts.push(context);
            const original = JSON.parse(Buffer.from(await outbound.readBody()).toString());
            outbound.body = JSON.stringify({ ...original, model: 'priced' });
          },
          onResponseChunk: (_context, chunk) => { raw.push(chunk); },
        }]);
        await runtime!.store.saveWorkspace({ ...emptyWorkspace(), models: [{
          id: 'priced', name: 'Priced', model: { filename: 'model.gguf' }, values: { inputUsdPerMillion: 2, outputUsdPerMillion: 4 },
        }] });
        const response = await fetch(`${base}/v1/messages/?beta=true`, { method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer client-token', 'x-api-key': 'client-key', Origin: 'https://client.example' },
          body: JSON.stringify(body) });
        expect(response.status).toBe(201);
        expect(response.headers.get('content-md5')).toBeNull();
        expect(response.headers.get('etag')).toBeNull();
        expect(response.headers.get('content-encoding')).toBeNull();
        expect(response.headers.get('x-upstream')).toBe('yes');
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
        expect(await response.json()).toMatchObject({ type: 'message', content: [{ type: 'text', text: 'Hello 😊' }], stop_reason: 'end_turn' });
        expect(observed).toMatchObject({ path: '/v1/chat/completions?beta=true', body: { model: 'priced', max_tokens: 256, messages: body.messages },
          auth: 'Bearer client-token', key: 'client-key', host: new URL(upstream).host, encoding: 'identity' });
        expect(contexts[0]).toMatchObject({ protocol: 'anthropic', path: '/v1/messages/?beta=true' });
        expect(JSON.parse(Buffer.concat(raw).toString())).toHaveProperty('choices');
        expect(JSON.stringify(observed)).not.toContain('hf_machine_secret');
        await vi.waitFor(() => expect(runtime!.usage.getSummary().session.costUsd).toBe(6));
      });
      it('leaves count_tokens, other OpenAI paths and non-POST requests byte-for-byte unchanged', async () => {
        let seen = '';
        const upstream = await listen(async (request, response) => {
          let body = '';
          for await (const chunk of request) body += chunk;
          seen = `${request.method} ${request.url} ${body}`;
          response.setHeader('Content-Type', 'application/json');
          response.end('{"native": true}\n');
        });
        const base = await enabled(upstream);
        for (const [method, path] of [['POST', '/v1/messages/count_tokens?beta=true'], ['GET', '/v1/messages'], ['POST', '/v1/chat/completions']]) {
          const response = await fetch(`${base}${path}`, { method, ...(method === 'POST' ? { body: 'unmodified bytes' } : {}) });
          expect(await response.text()).toBe('{"native": true}\n');
          expect(seen).toBe(`${method} ${path} ${method === 'POST' ? 'unmodified bytes' : ''}`);
        }
        await runtime!.store.saveSettings({ anthropicMode: 'passthrough' });
        const response = await fetch(`${base}/v1/messages/?x=1`, { method: 'POST', body: 'unmodified bytes' });
        expect(await response.text()).toBe('{"native": true}\n');
        expect(seen).toBe('POST /v1/messages/?x=1 unmodified bytes');
      });
      it('publishes native PP/TG and live usage before the gated upstream finishes, then persists final counts once', async () => {
        let upstreamResponse: import('node:http').ServerResponse | undefined;
        let outgoing: Record<string, unknown> = {};
        const upstream = await listen(async (request, response) => {
          let data = '';
          for await (const chunk of request) data += chunk;
          outgoing = JSON.parse(data);
          upstreamResponse = response;
          response.writeHead(200, { 'Content-Type': 'text/event-stream' });
          response.write(sse({ choices: [{ delta: { content: 'Hello' } }], usage: { completion_tokens: 0 } }) +
            sse({ timings: { prompt_n: 10, predicted_n: 1, prompt_per_second: 125.5, predicted_per_second: 32.5 } }));
        });
        const base = await enabled(upstream);
        const emit = vi.spyOn(runtime!.events, 'emit');
        const response = await fetch(`${base}/v1/messages`, { method: 'POST', body: JSON.stringify({ ...body, stream: true }) });
        const reader = response.body!.getReader();
        const first = Buffer.from((await reader.read()).value!).toString();
        expect(first).toContain('message_start');
        expect(first).not.toContain('message_stop');
        expect(outgoing).toMatchObject({ timings_per_token: true, stream_options: { include_usage: true }, stream: true });
        await vi.waitFor(() => expect(runtime!.usage.getSummary().session).toMatchObject({ inputTokens: 10, outputTokens: 1, requestCount: 1 }));
        expect(runtime!.usage.getSummary().session.costUsd).toBeGreaterThan(0);
        expect(emit.mock.calls.some(([event]) => event.type === 'throughput' && event.data.pp === 125.5 &&
          event.data.tg === 32.5 && event.data.protocol === 'anthropic' && event.data.active)).toBe(true);
        expect(upstreamResponse!.writableEnded).toBe(false);
        upstreamResponse!.end(sse({ timings: { prompt_n: 10, predicted_n: 2 } }) + 'data: [DONE]\n\n');
        let final = first;
        while (true) { const next = await reader.read(); if (next.done) break; final += Buffer.from(next.value).toString(); }
        expect(final).toContain('"output_tokens":2');
        expect(final).toContain('"stop_reason":"end_turn"');
        expect(final).not.toContain('timings');
        await runtime!.close();
        expect(runtime!.usage.getSummary().session).toMatchObject({ inputTokens: 10, outputTokens: 2, requestCount: 1, missingUsageRequests: 0 });
        runtime = await createApp({ dataDir: directory });
        expect(runtime.usage.getSummary().allTime).toMatchObject({ inputTokens: 10, outputTokens: 2, requestCount: 1 });
      });
      it.each([400, 401, 429, 503])('preserves upstream HTTP %i and retry headers while formatting errors', async status => {
        const upstream = await listen(async (request, response) => {
          for await (const _chunk of request) { /* Drain body. */ }
          response.writeHead(status, { 'Content-Type': 'application/json', 'Retry-After': '7' });
          response.end('{"error":{"message":"Upstream unavailable","type":"server_error"}}');
        });
        const base = await enabled(upstream);
        const response = await fetch(`${base}/v1/messages`, { method: 'POST', body: JSON.stringify({ ...body, stream: true }) });
        expect(response.status).toBe(status);
        expect(response.headers.get('retry-after')).toBe('7');
        expect(await response.json()).toMatchObject({ type: 'error', error: { message: 'Upstream unavailable' } });
      });
      it.each([
        ['invalid JSON', '{bad'],
        ['unsupported block', JSON.stringify({ ...body, messages: [{ role: 'user', content: [{ type: 'document', data: 'sensitive prompt' }] }] })],
        ['oversized JSON', JSON.stringify({ ...body, system: 'x'.repeat(2 * 1024 * 1024) })],
      ])('fails closed with actionable Anthropic 400 for %s', async (_label, payload) => {
        const called = vi.fn();
        const upstream = await listen((_request, response) => { called(); response.end(); });
        const base = await enabled(upstream);
        const response = await fetch(`${base}/v1/messages`, { method: 'POST', body: payload });
        expect(response.status).toBe(400);
        const error = await response.json();
        expect(error).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } });
        expect(JSON.stringify(error)).not.toContain('sensitive prompt');
        expect(called).not.toHaveBeenCalled();
      });
      it.each(['compressed', 'oversized', 'invalid-json', 'ignored-stream'])('fails closed on an incompatible upstream: %s', async mode => {
        const upstream = await listen(async (request, response) => {
          for await (const _chunk of request) { /* Drain body. */ }
          response.writeHead(200, { 'Content-Type': 'application/json', ...(mode === 'compressed' ? { 'Content-Encoding': 'gzip' } : {}) });
          response.end(mode === 'oversized' ? JSON.stringify({ padding: 'x'.repeat(2 * 1024 * 1024) }) :
            mode === 'invalid-json' ? '<html>not JSON</html>' : JSON.stringify(jsonCompletion));
        });
        const base = await enabled(upstream);
        const response = await fetch(`${base}/v1/messages`, { method: 'POST', body: JSON.stringify({ ...body, stream: mode === 'ignored-stream' }) });
        expect(response.status).toBe(502);
        expect(await response.json()).toMatchObject({ type: 'error', error: { type: 'api_error' } });
      });
      it('emits a partial-stream error without a success-shaped ending and records failure exactly once', async () => {
        const upstream = await listen(async (request, response) => {
          for await (const _chunk of request) { /* Drain body. */ }
          response.writeHead(200, { 'Content-Type': 'text/event-stream' });
          response.end(sse({ choices: [{ delta: { content: 'partial' } }], timings: { prompt_n: 10, predicted_n: 1 } }) +
            sse({ error: { message: 'Backend failed' } }));
        });
        const base = await enabled(upstream);
        const response = await fetch(`${base}/v1/messages`, { method: 'POST', body: JSON.stringify({ ...body, stream: true }) });
        const output = await response.text();
        expect(output).toContain('event: error');
        expect(output).not.toContain('message_stop');
        await vi.waitFor(() => expect(runtime!.usage.getSummary().session).toMatchObject({ requestCount: 1, missingUsageRequests: 1 }));
      });
      it('cancels a translated upstream when the downstream aborts', async () => {
        let cancelled = false;
        const upstream = await listen(async (request, response) => {
          for await (const _chunk of request) { /* Drain body. */ }
          response.writeHead(200, { 'Content-Type': 'text/event-stream' });
          response.write(sse({ choices: [{ delta: { content: 'first' } }] }));
          response.once('close', () => { cancelled = true; });
        });
        const base = await enabled(upstream);
        const controller = new AbortController();
        const response = await fetch(`${base}/v1/messages`, { method: 'POST', body: JSON.stringify({ ...body, stream: true }), signal: controller.signal });
        await response.body!.getReader().read();
        controller.abort();
        await vi.waitFor(() => expect(cancelled).toBe(true));
      });
      it('applies downstream backpressure to translated content instead of buffering the whole upstream', async () => {
        let bytesWritten = 0;
        let closed = false;
        const limit = 128 * 1024 * 1024;
        const upstream = await listen(async (request, response) => {
          for await (const _chunk of request) { /* Drain body. */ }
          response.writeHead(200, { 'Content-Type': 'text/event-stream' });
          const chunk = sse({ choices: [{ delta: { content: 'x'.repeat(32 * 1024) } }] });
          const pump = () => {
            while (!closed && bytesWritten < limit) {
              bytesWritten += chunk.length;
              if (!response.write(chunk)) { response.once('drain', pump); return; }
            }
            if (!closed) response.end('data: [DONE]\n\n');
          };
          response.once('close', () => { closed = true; });
          pump();
        });
        const base = await enabled(upstream);
        await new Promise<void>((resolve, reject) => {
          const request = httpRequest(`${base}/v1/messages`, { method: 'POST' }, response => {
            response.pause();
            setTimeout(() => {
              try { expect(bytesWritten).toBeLessThan(limit); }
              catch (error) { reject(error); }
              response.destroy();
              request.destroy();
              resolve();
            }, 100);
          });
          request.once('error', reject);
          request.end(JSON.stringify({ ...body, stream: true }));
        });
        await vi.waitFor(() => expect(closed).toBe(true));
      });
});

describe('inference accounting API integration', () => {
  const pricedModel = {
    id: 'priced', name: 'Priced', model: { filename: 'priced.gguf' }, values: {},
    pricing: { inputUsdPerMillion: 2, outputUsdPerMillion: 4 },
  };
  it('publishes live counters while the upstream SSE connection is still open', async () => {
    let upstreamResponse: import('node:http').ServerResponse | undefined;
    const upstream = await listen(async (request, response) => {
      for await (const _chunk of request) { /* Drain request before streaming. */ }
      upstreamResponse = response;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: {"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\n');
    });
    const base = await app(upstream);
    const response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{}' });
    const reader = response.body!.getReader();
    await reader.read();
    const live = await (await fetch(`${base}/api/usage`)).json();
    expect(live.session).toMatchObject({ inputTokens: 5, outputTokens: 1, requestCount: 1 });
    expect(live.allTime).toEqual(live.session);
    expect(upstreamResponse!.writableEnded).toBe(false);
    upstreamResponse!.write('data: {"usage":{"completion_tokens":4}}\n\n');
    await vi.waitFor(() => expect(runtime!.usage.getSummary().session.outputTokens).toBe(4));
    upstreamResponse!.end('data: [DONE]\n\n');
    while (!(await reader.read()).done) { /* Finish response. */ }
    await runtime!.close();
    const final = runtime!.usage.getSummary();
    expect(final.session).toMatchObject({ inputTokens: 5, outputTokens: 4, requestCount: 1 });
    runtime = await createApp({ dataDir: directory });
    expect(runtime.usage.getSummary().allTime).toEqual(final.allTime);
  });
  it('counts concurrent real responses, serves bootstrap and fresh/reconnected SSE snapshots without recounting', async () => {
    const upstream = await listen(async (request, response) => {
      for await (const _chunk of request) { /* Drain the unmodified request. */ }
      response.setHeader('Content-Type', 'application/json');
      response.end('{"response":{"usage":{"input_tokens":3,"output_tokens":2}}}');
    });
    const base = await app(upstream);
    await runtime!.store.saveWorkspace({ ...emptyWorkspace(), models: [pricedModel] });
    await Promise.all(Array.from({ length: 5 }, async () => {
      const response = await fetch(`${base}/v1/responses`, { method: 'POST', body: '{"model":"priced"}' });
      expect(await response.text()).toContain('"input_tokens":3');
    }));
    await vi.waitFor(() => expect(runtime!.usage.getSummary().session.requestCount).toBe(5));
    const usage = await (await fetch(`${base}/api/usage`)).json();
    expect(usage.session).toMatchObject({ inputTokens: 15, outputTokens: 10, requestCount: 5, missingUsageRequests: 0 });
    expect(usage.session.costUsd).toBeCloseTo(0.00007);
    expect(usage.allTime).toEqual(usage.session);
    expect((await (await fetch(`${base}/api/bootstrap`)).json()).usage).toEqual(usage);
    for (const lastId of [undefined, '0', '99999']) {
      const controller = new AbortController();
      const response = await fetch(`${base}/api/events`, { signal: controller.signal, headers: lastId ? { 'Last-Event-ID': lastId } : {} });
      const reader = response.body!.getReader();
      const text = new TextDecoder().decode((await reader.read()).value);
      expect(text).toContain(`data: ${JSON.stringify({ type: 'usage', data: usage })}`);
      controller.abort();
      await reader.cancel().catch(() => {});
    }
    expect(runtime!.usage.getSummary().session.requestCount).toBe(5);
    await runtime!.close();
    runtime = await createApp({ dataDir: directory });
    expect(runtime.usage.getSummary().allTime).toEqual(usage.allTime);
    expect(runtime.usage.getSummary().session.requestCount).toBe(0);
  });
  it('observes the outbound model after every beforeRequest hook, without using the original model', async () => {
    let sent = '';
    const upstream = await listen(async (request, response) => {
      for await (const chunk of request) sent += chunk.toString();
      response.setHeader('Content-Type', 'application/json');
      response.end('{"usage":{"prompt_tokens":1000000,"completion_tokens":1000000}}');
    });
    const base = await app(upstream, [
      { beforeRequest: (_context, outbound) => { outbound.body = '{"model":"wrong"}'; } },
      { beforeRequest: (_context, outbound) => { outbound.body = '{"model":"priced"}'; } },
    ]);
    await runtime!.store.saveWorkspace({
      ...emptyWorkspace(), models: [pricedModel, { ...pricedModel, id: 'wrong', pricing: { inputUsdPerMillion: 100, outputUsdPerMillion: 100 } }],
    });
    await (await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{"model":"wrong"}' })).text();
    await vi.waitFor(() => expect(runtime!.usage.getSummary().session.requestCount).toBe(1));
    expect(sent).toBe('{"model":"priced"}');
    expect(runtime!.usage.getSummary().session.costUsd).toBe(6);
  });
  it('accounts Anthropic SSE cache usage and repeated deltas without changing streamed bytes', async () => {
    const text = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":8,"output_tokens":0,"cache_read_input_tokens":10,"cache_creation_input_tokens":2}}}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":4}}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":4}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const upstream = await listen(async (request, response) => {
      for await (const _chunk of request) { /* Drain the unmodified request. */ }
      response.setHeader('Content-Type', 'text/event-stream');
      for (const byte of Buffer.from(text)) response.write(Buffer.of(byte));
      response.end();
    });
    const base = await app(upstream);
    await runtime!.store.saveWorkspace({ ...emptyWorkspace(), models: [pricedModel] });
    const response = await fetch(`${base}/v1/messages`, { method: 'POST', body: '{"model":"priced"}' });
    expect(await response.text()).toBe(text);
    await vi.waitFor(() => expect(runtime!.usage.getSummary().session.requestCount).toBe(1));
    expect(runtime!.usage.getSummary().session).toMatchObject({ inputTokens: 20, outputTokens: 4, missingUsageRequests: 0, unpricedTokens: 0 });
    expect(runtime!.usage.getSummary().session.costUsd).toBeCloseTo(0.000056);
  });
  it('uses managed pricing for default or equivalent explicit upstreams, but not a different server', async () => {
    const handler: RequestListener = async (request, response) => {
      for await (const _chunk of request) { /* Drain the unmodified request. */ }
      response.setHeader('Content-Type', 'application/json');
      response.end('{"usage":{"prompt_tokens":1000000,"completion_tokens":1000000}}');
    };
    const upstream = await listen(handler);
    const external = await listen(handler);
    const base = await app();
    await runtime!.store.saveWorkspace({
      ...emptyWorkspace(), models: [pricedModel, { ...pricedModel, id: 'other', pricing: { inputUsdPerMillion: 10, outputUsdPerMillion: 10 } }],
    });
    vi.spyOn(runtime!.manager, 'getManagedPort').mockReturnValue(Number(new URL(upstream).port));
    vi.spyOn(runtime!.manager, 'getStatus').mockReturnValue({ phase: 'ready', modelId: 'priced' });
    await (await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{"model":"other"}' })).text();
    await vi.waitFor(() => expect(runtime!.usage.getSummary().session.costUsd).toBe(6));
    await runtime!.store.saveSettings({ upstreamUrl: upstream });
    await (await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{"model":"unknown"}' })).text();
    await vi.waitFor(() => expect(runtime!.usage.getSummary().session.costUsd).toBe(12));
    expect(runtime!.usage.getSummary().session.unpricedTokens).toBe(0);
    await runtime!.store.saveSettings({ upstreamUrl: upstream.replace('127.0.0.1', 'localhost') });
    await (await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{"model":"unknown"}' })).text();
    await vi.waitFor(() => expect(runtime!.usage.getSummary().session.costUsd).toBe(18));
    await runtime!.store.saveSettings({ upstreamUrl: external });
    await (await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{"model":"other"}' })).text();
    await vi.waitFor(() => expect(runtime!.usage.getSummary().session.costUsd).toBe(38));
    await (await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{"model":"unknown"}' })).text();
    await vi.waitFor(() => expect(runtime!.usage.getSummary().session.costUsd).toBeCloseTo(40.25));
    expect(runtime!.usage.getSummary().session.unpricedTokens).toBe(0);
  });
  it.each(['cancel', 'shutdown', 'upstream-error'])('persists partial streamed counts once on %s and waits for accounting during close', async mode => {
    let finish!: () => void;
    const first = 'data: {"usage":{"prompt_tokens":8,"completion_tokens":2}}\n\n';
    const upstream = await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(first);
      finish = () => response.destroy();
    });
    const base = await app(upstream);
    const controller = new AbortController();
    const response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{}', signal: controller.signal });
    const reader = response.body!.getReader();
    expect(Buffer.from((await reader.read()).value!).toString()).toBe(first);
    if (mode === 'cancel') controller.abort();
    else if (mode === 'upstream-error') finish();
    else await runtime!.close();
    await reader.cancel().catch(() => {});
    await vi.waitFor(() => expect(runtime!.usage.getSummary().session.missingUsageRequests).toBe(1));
    expect(runtime!.usage.getSummary().session).toMatchObject({ inputTokens: 8, outputTokens: 2, missingUsageRequests: 1, unpricedTokens: 0 });
    expect(runtime!.usage.getSummary().session.costUsd).toBeCloseTo(0.000006, 10);
    await runtime!.close();
    runtime = await createApp({ dataDir: directory });
    expect(runtime.usage.getSummary().allTime).toMatchObject({ inputTokens: 8, outputTokens: 2, requestCount: 1, missingUsageRequests: 1 });
  });
  it('keeps protocol bytes untouched while publishing durable-storage errors visibly in the API/events and close', async () => {
    const upstream = await listen((_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end('{"usage":{"prompt_tokens":8,"completion_tokens":2}}');
    });
    const base = await app(upstream);
    const emit = vi.spyOn(runtime!.events, 'emit');
    await rm(join(directory, 'usage.json'));
    await mkdir(join(directory, 'usage.json'));
    const response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{}' });
    expect(await response.text()).toBe('{"usage":{"prompt_tokens":8,"completion_tokens":2}}');
    await vi.waitFor(() => expect(runtime!.usage.getSummary().error).toContain('could not be saved'));
    expect((await (await fetch(`${base}/api/usage`)).json()).error).toContain('could not be saved');
    expect(emit.mock.calls.some(([event]) => event.type === 'usage' && event.data.error)).toBe(true);
    await expect(runtime!.close()).rejects.toThrow('could not be saved');
  });
});
