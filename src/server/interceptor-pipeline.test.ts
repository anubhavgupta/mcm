import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { InterceptorRegistry, loadInterceptorModule } from './interceptor-pipeline';
import { atomicJson } from './storage';
import type { Interceptor, OutboundRequest, RequestContext } from './interceptors';
import type { CustomInterceptorEntry } from '../shared/types';

let directory: string;
const required: [Interceptor, Interceptor] = [{ onRequest() {} }, { onComplete() {} }];
const context: RequestContext = {
  requestId: 'test', protocol: 'openai', method: 'POST', path: '/v1/chat/completions',
  headers: {}, signal: new AbortController().signal,
};
beforeEach(async () => {
  directory = resolve(`src/server/.test-data-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
});
afterEach(async () => { await rm(directory, { force: true, recursive: true }); });
async function moduleEntry(name: string, source?: string): Promise<CustomInterceptorEntry> {
  const modulePath = join(directory, `${name}.mjs`);
  await writeFile(modulePath, source ?? `export default {
    beforeRequest(_context, outbound) { outbound.headers['x-order'] = (outbound.headers['x-order'] ?? '') + ${JSON.stringify(name)}; }
  };`);
  return { id: `custom-${name}`, name, modulePath };
}
const update = (entries: CustomInterceptorEntry[]) => ({ entries, trustedCodeAcknowledged: true });
async function order(registry: InterceptorRegistry): Promise<unknown> {
  const outbound: OutboundRequest = { headers: {}, readBody: async () => new Uint8Array() };
  for (const interceptor of registry.snapshot()) await interceptor.beforeRequest?.(context, outbound);
  return outbound.headers['x-order'];
}

describe('durable trusted interceptor pipeline', () => {
  it('persists custom order, flattens arrays, and always retains both required components and environment code', async () => {
    const environment = { onRequest() {} };
    const registry = new InterceptorRegistry(directory, required, [environment]);
    await registry.init();
    const a = await moduleEntry('A');
    const b = await moduleEntry('B', `export const interceptors = [
      { beforeRequest(_context, outbound) { outbound.headers['x-order'] += 'B1'; } },
      { beforeRequest(_context, outbound) { outbound.headers['x-order'] += 'B2'; } }
    ];`);
    await registry.update(update([a, b]));
    expect(await order(registry)).toBe('AB1B2');
    expect(registry.snapshot().slice(0, 3)).toEqual([...required, environment]);
    expect(registry.get().entries.slice(0, 2)).toEqual([
      { id: 'builtin-telemetry', name: 'Token and cost telemetry', source: 'builtin', locked: true },
      { id: 'environment-interceptors', name: 'Environment-configured interceptors', source: 'environment', locked: true },
    ]);
    const exposed = registry.get();
    exposed.entries.pop();
    const snapshot = registry.snapshot() as Interceptor[];
    snapshot.length = 0;
    expect(registry.get().entries).toHaveLength(4);
    expect(registry.snapshot()).toHaveLength(6);
    const reopened = new InterceptorRegistry(directory, required, [environment]);
    await reopened.init();
    expect(reopened.get()).toEqual(registry.get());
    expect(await order(reopened)).toBe('AB1B2');
    if (process.platform !== 'win32') expect((await stat(join(directory, 'interceptors.json'))).mode & 0o777).toBe(0o600);
    await registry.update(update([]));
    expect(registry.snapshot()).toEqual([...required, environment]);
    expect(registry.get().entries.every(entry => entry.locked)).toBe(true);
  });

  it('rejects invalid schemas and attempts to alter required entries without changing persisted or active configuration', async () => {
    const registry = new InterceptorRegistry(directory, required);
    await registry.init();
    const a = await moduleEntry('A');
    await registry.update(update([a]));
    const persisted = await readFile(join(directory, 'interceptors.json'), 'utf8');
    for (const input of [
      { entries: [] }, { entries: [], trustedCodeAcknowledged: false },
      { ...update([]), enabled: false },
      update([{ ...a, id: 'builtin-telemetry' }]), update([{ ...a, id: 'environment-interceptors' }]),
      update([{ ...a, name: ' ' }]), update([{ ...a, name: 'x'.repeat(101) }]),
      update([{ ...a, name: 'bad\nname' }]), update([{ ...a, modulePath: 'relative.mjs' }]),
      update([{ ...a, modulePath: 'https://example.test/module.mjs' }]),
      update([{ ...a, modulePath: '/bad\0path' }]), update([{ ...a, modulePath: '/'.repeat(4097) }]),
      update([a, a]), update([a, { ...a, id: 'custom-other' }]),
      update(Array.from({ length: 33 }, (_, index) => ({ ...a, id: `custom-${index}`, modulePath: `${a.modulePath}${index}` }))),
      { ...update([]), entries: [{ ...a, enabled: false }] },
      { ...update([]), entries: [{ ...a, locked: false }] },
    ]) {
      await expect(registry.update(input)).rejects.toThrow();
      expect(await order(registry)).toBe('A');
      expect(await readFile(join(directory, 'interceptors.json'), 'utf8')).toBe(persisted);
    }
  });

  it('does not activate any part of an invalid module batch or failed durable write', async () => {
    const write = vi.fn(atomicJson);
    const registry = new InterceptorRegistry(directory, required, [], write);
    await registry.init();
    const a = await moduleEntry('A');
    const b = await moduleEntry('B');
    await registry.update(update([a]));
    const persisted = await readFile(join(directory, 'interceptors.json'), 'utf8');
    for (const [index, source] of [
      'export default {};', 'export default [];', 'export default { beforeRequest: true };',
      'export default [{ onRequest() {} }, { onComplete: 1 }];', 'throw new Error("private module detail");',
      'export default "invalid";', 'invalid JavaScript !',
    ].entries()) {
      const invalid = await moduleEntry(`bad${index}`, source);
      await expect(registry.update(update([b, invalid]))).rejects.toThrow('Cannot load interceptor module.');
      expect(await order(registry)).toBe('A');
    }
    await expect(registry.update(update([{ ...b, modulePath: join(directory, 'missing.mjs') }]))).rejects.toThrow('Cannot load');
    await expect(loadInterceptorModule(directory)).rejects.toThrow('Cannot load');
    write.mockRejectedValueOnce(new Error('Disk full'));
    await expect(registry.update(update([b]))).rejects.toThrow('Disk full');
    expect(await order(registry)).toBe('A');
    expect(await readFile(join(directory, 'interceptors.json'), 'utf8')).toBe(persisted);
    await registry.update(update([b]));
    expect(await order(registry)).toBe('B');
  });

  it('serializes overlapping writes and activates only complete saved sequences', async () => {
    const write = vi.fn(atomicJson);
    const registry = new InterceptorRegistry(directory, required, [], write);
    await registry.init();
    const a = await moduleEntry('A');
    const b = await moduleEntry('B');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    write.mockImplementationOnce(async (...args) => { await gate; await atomicJson(...args); });
    const first = registry.update(update([a]));
    const second = registry.update(update([b, a]));
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(await order(registry)).toBeUndefined();
    release();
    expect((await first).entries.at(-1)?.name).toBe('A');
    await second;
    expect(await order(registry)).toBe('BA');
    expect(JSON.parse(await readFile(join(directory, 'interceptors.json'), 'utf8'))).toEqual({ entries: [b, a] });
    await registry.close();
    await expect(registry.update(update([]))).rejects.toThrow('shutting down');
  });

  it('fails startup on corrupt persisted data or unavailable modules without replacing it', async () => {
    const path = join(directory, 'interceptors.json');
    const invalidModule = await moduleEntry('bad', 'export default { onComplete: false };');
    for (const text of ['not json', '{"entries":null}', JSON.stringify({ entries: [invalidModule] })]) {
      await writeFile(path, text);
      await expect(new InterceptorRegistry(directory, required).init()).rejects.toThrow();
      expect(await readFile(path, 'utf8')).toBe(text);
    }
  });
});
