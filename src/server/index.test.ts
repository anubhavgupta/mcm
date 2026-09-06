import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

let directory: string;
const children: ChildProcess[] = [];
beforeEach(async () => {
  directory = resolve(`src/server/.test-data-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
});
afterEach(async () => {
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, 'close');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    try { await closed; } finally { clearTimeout(timer); }
  }));
  await rm(directory, { recursive: true, force: true });
});

describe('loopback entrypoint and trusted interceptor modules', () => {
  it.each(['default', 'named'])('loads %s interceptor arrays, exposes same-origin APIs, and shuts down cleanly', async exportType => {
    const probe = createServer().listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>(resolve => probe.close(() => resolve()));
    const interceptor = join(directory, 'observer.mjs');
    await writeFile(interceptor, `${exportType === 'default' ? 'export default' : 'export const interceptors ='} [{ beforeRequest(context, outbound) { outbound.headers["x-example"] = context.requestId; } }];`);
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'production', MCM_PORT: String(port), MCM_DATA_DIR: join(directory, 'data'), MCM_INTERCEPTOR_MODULE: interceptor },
    });
    children.push(child);
    let output = '';
    child.stdout!.on('data', chunk => { output += chunk.toString(); });
    child.stderr!.on('data', chunk => { output += chunk.toString(); });
    await vi.waitFor(() => expect(output).toContain(`http://127.0.0.1:${port}`), { timeout: 10000 });
    const response = await fetch(`http://127.0.0.1:${port}/api/bootstrap`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: { phase: 'stopped' }, settings: { hfTokenConfigured: false } });
    const closed = once(child, 'close');
    child.kill('SIGTERM');
    const [code] = await closed;
    expect(code).toBe(0);
    await expect(fetch(`http://127.0.0.1:${port}/api/bootstrap`)).rejects.toThrow();
  });
  it('rejects remote or relative interceptor module paths without loading them', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'production', MCM_DATA_DIR: join(directory, 'data'), MCM_INTERCEPTOR_MODULE: 'https://attacker.example/module.js' },
    });
    children.push(child);
    let output = '';
    child.stderr!.on('data', chunk => { output += chunk.toString(); });
    const [code] = await once(child, 'close');
    expect(code).toBe(1);
    expect(output).toContain('trusted interceptor module');
  });
});
