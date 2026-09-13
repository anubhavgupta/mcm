import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { emptyWorkspace } from '../src/shared/config.ts';
import { startDesktopServer } from './server.ts';

const directory = resolve(`test-results/desktop-smoke-${crypto.randomUUID()}`);
await Deno.mkdir(directory, { recursive: true });
let backend: Awaited<ReturnType<typeof startDesktopServer>> | undefined;
let reloaded: Awaited<ReturnType<typeof startDesktopServer>> | undefined;
const upstream = createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'x-desktop-smoke': String(request.headers['x-desktop-smoke']) });
  response.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
  const timer = setTimeout(() => {
    response.end('data: {"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\ndata: [DONE]\n\n');
  }, 100);
  response.on('close', () => clearTimeout(timer));
});
try {
  const executable = join(directory, Deno.build.os === 'windows' ? 'llama-fixture.exe' : 'llama-fixture');
  const compile = await new Deno.Command(Deno.execPath(), {
    args: ['compile', '--no-config', '--no-npm', '-A', '--output', executable, fileURLToPath(new URL('./fixture.ts', import.meta.url))],
    stdout: 'null', stderr: 'piped',
  }).output();
  assert.equal(compile.success, true, new TextDecoder().decode(compile.stderr));
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  backend = await startDesktopServer({ dataDir: directory, ports: [0, 0] });
  const base = `http://127.0.0.1:${(backend.servers[0].address() as AddressInfo).port}`;
  const native = `http://127.0.0.1:${(backend.servers[1].address() as AddressInfo).port}`;
  const request = async (path: string, body: unknown, origin = base) => {
    const response = await fetch(`${base}${path}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body),
    });
    return response;
  };
  assert.match(await (await fetch(native)).text(), /<html/);
  assert.equal((await fetch(`${native}/api/bootstrap`, { headers: { Origin: native } })).status, 200);
  assert.equal((await request('/api/settings', { theme: 'nord' }, 'https://untrusted.example')).status, 403);
  assert.equal((await request('/api/settings', { upstreamUrl: 'file:///bad' })).status, 400);
  assert.equal((await request('/api/settings', { serverPort: 0 })).status, 400);
  assert.equal((await request('/api/settings', {
    theme: 'nord', upstreamUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
  })).status, 200);
  assert.equal((await request('/api/workspace', {
    ...emptyWorkspace(), models: [{ id: 'smoke', name: 'Smoke model', model: { filename: 'smoke.gguf' }, values: {} }],
  })).status, 200);
  await Deno.writeTextFile(join(directory, 'smoke.gguf'), 'test fixture, not a model');
  const portProbe = createServer();
  portProbe.listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const serverPort = (portProbe.address() as AddressInfo).port;
  await new Promise<void>(resolve => portProbe.close(() => resolve()));
  assert.equal((await request('/api/settings', { executablePath: executable, modelsDirectory: directory, serverPort })).status, 200);
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body),
  });
  assert.equal((await (await post('/api/version', { executablePath: executable })).json()).version, 'b9000 (abcdef12)');
  assert.equal((await post('/api/preview', { modelId: 'smoke' })).status, 200);
  assert.equal((await post('/api/launch', { modelId: 'smoke' })).status, 200);
  const ready = async () => {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (backend!.runtime.manager.getStatus().phase === 'ready') return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail('Managed fixture did not become ready');
  };
  await ready();
  assert.equal((await post('/api/stop', {})).status, 200);
  assert.equal(backend.runtime.manager.getStatus().phase, 'stopped');
  assert.equal((await post('/api/launch', { modelId: 'smoke' })).status, 200);
  await ready();
  const modulePath = join(directory, 'custom.ts');
  await Deno.writeTextFile(modulePath, 'export default { beforeRequest(_context: unknown, outbound: { headers: Record<string, string> }) { outbound.headers["x-desktop-smoke"] = "yes"; } };');
  assert.equal((await request('/api/interceptors', {
    trustedCodeAcknowledged: true, entries: [{ id: 'custom-smoke', name: 'Smoke', modulePath }],
  })).status, 200);
  const events = new AbortController();
  const eventResponse = await fetch(`${native}/api/events`, { signal: events.signal });
  const eventReader = eventResponse.body!.getReader();
  assert.match(new TextDecoder().decode((await eventReader.read()).value), /data:/);
  events.abort();
  await eventReader.cancel().catch(() => {});
  const response = await fetch(`${native}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'smoke', stream: true }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-desktop-smoke'), 'yes');
  const reader = response.body!.getReader();
  let text = new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /Hello/);
  assert.doesNotMatch(text, /\[DONE\]/);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  assert.match(text, /\[DONE\]/);
  await assert.rejects(startDesktopServer({ dataDir: directory, ports: [0] }), /data is locked/);
  await assert.rejects(startDesktopServer({
    dataDir: join(directory, 'other'), ports: [(backend.servers[0].address() as AddressInfo).port],
  }), /cannot listen/);
  const active = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{}' });
  const activeReader = active.body!.getReader();
  await activeReader.read();
  await backend.close();
  await activeReader.cancel().catch(() => {});
  assert.equal(backend.servers.every(server => !server.listening), true);
  assert.equal(backend.runtime.manager.getStatus().phase, 'stopped');
  await assert.rejects(fetch(`http://127.0.0.1:${serverPort}/health`));
  reloaded = await startDesktopServer({ dataDir: directory, ports: [0] });
  assert.equal(reloaded.runtime.store.getSettings().theme, 'nord');
  assert.equal(reloaded.runtime.store.getWorkspace().models[0].name, 'Smoke model');
  assert.equal(reloaded.runtime.usage.getSummary().allTime.inputTokens, 10);
  assert.equal(reloaded.runtime.usage.getSummary().allTime.outputTokens, 2);
  assert.equal(reloaded.runtime.manager.getStatus().phase, 'stopped');
  console.log('Deno desktop smoke passed: same-origin UI/API, validation, settings/workspace persistence, external TS interceptor, live SSE/proxy, usage flush, port/data locks, version probe, managed process start/stop and shutdown.');
} finally {
  await reloaded?.close();
  await backend?.close();
  await new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections(); });
  await Deno.remove(directory, { recursive: true });
}
