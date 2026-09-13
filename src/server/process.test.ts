import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Store } from './storage';
import { Events } from './events';
import { discoverCapabilities, discoverVersion, ProcessManager } from './process';
import { emptyWorkspace } from '../shared/config';

let directory: string;
let store: Store;
let manager: ProcessManager | undefined;
let port: number;
async function fixture(contents: string): Promise<string> {
  const path = join(directory, `fixture-${randomUUID()}.mjs`);
  await writeFile(path, `#!${process.execPath}\n${contents}`);
  await chmod(path, 0o700);
  return path;
}
beforeEach(async () => {
  directory = resolve(`src/server/.test-data-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  store = new Store(join(directory, 'data'));
  await store.init();
  await mkdir(join(directory, 'models'));
  await writeFile(join(directory, 'models/model.gguf'), 'gguf');
  await store.saveWorkspace({ ...emptyWorkspace(), models: [{ id: 'model', name: 'Model', model: { filename: 'model.gguf' }, values: {} }] });
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = (server.address() as AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  await store.saveSettings({ serverPort: port, modelsDirectory: join(directory, 'models') });
});
afterEach(async () => {
  await manager?.close();
  manager = undefined;
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('bounded executable capability discovery', () => {
  it('extracts flags from stdout and stderr without returning the machine token', async () => {
    const path = await fixture(`console.log('--model --host --port --metrics --threads -t hf_private'); console.error('--temp');`);
    await store.saveSettings({ executablePath: path, hfToken: 'hf_private' });
    const result = await discoverCapabilities(store.getSettings());
    expect(result.flags).toContain('--metrics');
    expect(result.flags).toContain('--temp');
    expect(result.help).not.toContain('hf_private');
  });
  it('kills hung help probes and caps their output', async () => {
    const hung = await fixture('setInterval(() => {}, 1000);');
    await store.saveSettings({ executablePath: hung });
    await expect(discoverCapabilities(store.getSettings(), 100)).rejects.toThrow('timed out');
    const large = await fixture(`process.stdout.write('x'.repeat(2 * 1024 * 1024)); setInterval(() => {}, 1000);`);
    await store.saveSettings({ executablePath: large });
    await expect(discoverCapabilities(store.getSettings(), 2000)).rejects.toThrow('output limit');
  });
  it('rejects missing/nonabsolute executable paths', async () => {
    await store.saveSettings({ executablePath: 'llama-server' });
    await expect(discoverCapabilities(store.getSettings())).rejects.toThrow('absolute');
  });
});

describe('private bounded version discovery', () => {
  it.each(['stdout', 'stderr'])('extracts only a canonical version from %s diagnostics', async stream => {
    vi.stubEnv('HF_TOKEN', 'hf_private');
    vi.stubEnv('HUGGING_FACE_HUB_TOKEN', 'hf_private');
    vi.stubEnv('HUGGINGFACE_TOKEN', 'hf_private');
    vi.stubEnv('OTHER_SECRET', 'hf_private');
    vi.stubEnv('DENO_SERVE_ADDRESS', 'tcp:127.0.0.1:45678');
    vi.stubEnv('MCM_DESKTOP_SMOKE', '1');
    const path = await fixture(`
      if (process.argv.slice(2).join() !== '--version') process.exit(9);
      if (['HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN', 'HUGGINGFACE_TOKEN', 'OTHER_SECRET', 'DENO_SERVE_ADDRESS', 'MCM_DESKTOP_SMOKE'].some(key => process.env[key])) process.exit(8);
      process.${stream}.write('CUDA init: /private/build hf_private\\nversion: 12345 (abcdef)\\nbuilt at /private/user\\n');
    `);
    await store.saveSettings({ executablePath: path, hfToken: 'hf_private' });
    expect(await discoverVersion(store.getSettings())).toEqual({ executablePath: path, version: '12345 (abcdef)' });
  });
  it('recognizes prefixed builds without publishing paths, credentials or trailing text', async () => {
    const path = await fixture(`console.log('llama.cpp version: b1234 (abcdef) built at /private/path credential=secret');`);
    await store.saveSettings({ executablePath: path });
    expect((await discoverVersion(store.getSettings())).version).toBe('b1234 (abcdef)');
    await store.saveSettings({ hfToken: 'abcdef' });
    expect((await discoverVersion(store.getSettings())).version).toBe('b1234');
  });
  it('rejects unrecognized output without echoing private diagnostics', async () => {
    for (const output of ['built with clang 19 at /private/user hf_secret', 'version: /private/1234', 'version: hf_secret']) {
      await store.saveSettings({ executablePath: await fixture(`console.log(${JSON.stringify(output)});`) });
      await expect(discoverVersion(store.getSettings())).rejects.toThrow('did not report a recognized');
    }
  });
  it('limits time and total output across both streams, and reports missing paths', async () => {
    await store.saveSettings({ executablePath: await fixture('setInterval(() => {}, 1000);') });
    await expect(discoverVersion(store.getSettings(), 100)).rejects.toThrow('--version timed out');
    await store.saveSettings({ executablePath: await fixture(`process.stdout.write('x'.repeat(700000)); process.stderr.write('x'.repeat(700000)); setInterval(() => {}, 1000);`) });
    await expect(discoverVersion(store.getSettings(), 2000)).rejects.toThrow('output limit');
    await store.saveSettings({ executablePath: join(directory, 'missing') });
    await expect(discoverVersion(store.getSettings())).rejects.toThrow('missing or not executable');
  });
  it('retains valid help with a visible warning when --version is unsupported', async () => {
    await store.saveSettings({ executablePath: await fixture(`
      if (process.argv.includes('--version')) process.exit(1);
      console.log('--model --host --port');
    `) });
    const result = await discoverCapabilities(store.getSettings());
    expect(result.flags).toContain('--model');
    expect(result.version).toBeUndefined();
    expect(result.compatibilityWarning).toContain('Could not verify executable version');
  });
});

describe('serialized child lifecycle and health readiness', () => {
  it('previews ordered speculation and resolves a draft GGUF separately from the target', async () => {
    const path = await fixture(`throw new Error('preview must not spawn');`);
    await store.saveSettings({ executablePath: path });
    await writeFile(join(directory, 'models/draft model.gguf'), 'draft');
    const workspace = store.getWorkspace();
    workspace.base = { speculation: 'ngram-mod,draft-simple', draftModel: 'draft model.gguf', draftGpuLayers: 0 };
    await store.saveWorkspace(workspace);
    manager = new ProcessManager(store, new Events());
    const preview = await manager.preview('model');
    expect(preview.args.slice(preview.args.indexOf('--spec-type'), preview.args.indexOf('--spec-type') + 2))
      .toEqual(['--spec-type', 'ngram-mod,draft-simple']);
    expect(preview.args[preview.args.indexOf('--spec-draft-model') + 1]).toBe(join(directory, 'models/draft model.gguf'));
    expect(preview.args[preview.args.indexOf('--model') + 1]).toBe(join(directory, 'models/model.gguf'));
    expect(preview.args[preview.args.indexOf('--spec-draft-ngl') + 1]).toBe('0');
  });
  it('requires explicit local bindings for ambiguous draft files and ignores them when disabled', async () => {
    await store.saveSettings({ executablePath: await fixture('') });
    for (const folder of ['a', 'b']) {
      await mkdir(join(directory, 'models', folder));
      await writeFile(join(directory, 'models', folder, 'draft.gguf'), 'draft');
    }
    await store.saveWorkspace({ ...store.getWorkspace(), base: { speculation: 'draft-simple', draftModel: 'draft.gguf' } });
    manager = new ProcessManager(store, new Events());
    await expect(manager.preview('model')).rejects.toThrow('Multiple files match');
    await store.saveSettings({ draftModelBindings: { model: 'b/draft.gguf' } });
    const preview = await manager.preview('model');
    expect(preview.args[preview.args.indexOf('--spec-draft-model') + 1]).toBe(join(directory, 'models/b/draft.gguf'));
    await store.saveWorkspace({ ...store.getWorkspace(), base: { speculation: 'none', draftModel: 'missing.gguf' } });
    expect((await manager.preview('model')).args).not.toContain('--spec-draft-model');
  });
  it('cannot substitute the target binding for an absent draft file', async () => {
    await store.saveSettings({ executablePath: await fixture(''), modelBindings: { model: 'model.gguf' } });
    await store.saveWorkspace({ ...store.getWorkspace(), base: { speculation: 'draft-dflash', draftModel: 'absent.gguf' } });
    manager = new ProcessManager(store, new Events());
    await expect(manager.preview('model')).rejects.toThrow('absent.gguf was not found');
  });
  async function serverFixture(ignoreTerm = false, healthDelay = 250, version = '12345 (abcdef)', helpDelay = 0): Promise<string> {
    return fixture(`
      import { createServer } from 'node:http';
      import { writeFileSync } from 'node:fs';
      if (process.argv.includes('--version')) {
        console.log(${JSON.stringify(`version: ${version}`)});
        process.exit(0);
      }
      if (process.argv.includes('--help')) {
        writeFileSync(${JSON.stringify(join(directory, 'help-started.txt'))}, process.argv[1]);
        if (${helpDelay}) await new Promise(resolve => setTimeout(resolve, ${helpDelay}));
        console.log('--model --host --port --metrics --threads');
        process.exit(0);
      }
      writeFileSync(${JSON.stringify(join(directory, 'args.json'))}, JSON.stringify(process.argv.slice(2)));
      writeFileSync(${JSON.stringify(join(directory, 'executable.txt'))}, process.argv[1]);
      writeFileSync(${JSON.stringify(join(directory, 'environment.json'))}, JSON.stringify({ hf: process.env.HF_TOKEN ?? null }));
      const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
      const start = Date.now();
      const server = createServer((_request, response) => {
        response.statusCode = Date.now() - start >= ${healthDelay} ? 200 : 503;
        response.end('{}');
      }).listen(port, '127.0.0.1');
      ${ignoreTerm ? "process.on('SIGTERM', () => {});" : "process.on('SIGTERM', () => server.close(() => process.exit(0)));"}
    `);
  }
  it('resolves all preview layers and uses current model/group overrides for launch and restart', async () => {
    const machine = await serverFixture();
    const base = await serverFixture();
    const group = await serverFixture(false, 0, '23456 (abcdef)');
    const model = await serverFixture(false, 0, '34567 (abcdef)');
    const workspace = store.getWorkspace();
    workspace.llamaVersion = '1';
    workspace.groups = [{ id: 'group', name: 'Group', values: {}, llamaVersion: '23456 (abcdef)' }];
    workspace.models[0]!.groupId = 'group';
    workspace.models[0]!.llamaVersion = '34567 (abcdef)';
    await store.saveWorkspace(workspace);
    await store.saveSettings({ executablePath: machine });
    manager = new ProcessManager(store, new Events(), { healthIntervalMs: 10 });
    expect((await manager.preview('model')).executable).toBe(machine);
    await store.saveSettings({ executableOverrides: { base } });
    expect((await manager.preview('model')).executable).toBe(base);
    await store.saveSettings({ executableOverrides: { base, groups: { group } } });
    expect((await manager.preview('model')).executable).toBe(group);
    await store.saveSettings({ executableOverrides: { base, groups: { group }, models: { model } } });
    expect((await manager.preview('model')).executable).toBe(model);
    expect((await manager.launch('model')).compatibilityWarning).toBeUndefined();
    await vi.waitFor(() => expect(manager!.getStatus().phase).toBe('ready'));
    expect(await readFile(join(directory, 'executable.txt'), 'utf8')).toBe(model);
    await store.saveSettings({ executableOverrides: { base, groups: { group } } });
    const restarted = await manager.restart();
    expect(restarted.compatibilityWarning).toContain('34567 (abcdef)');
    expect(restarted.compatibilityWarning).toContain('23456 (abcdef)');
    await vi.waitFor(() => expect(manager!.getStatus().phase).toBe('ready'));
    expect(await readFile(join(directory, 'executable.txt'), 'utf8')).toBe(group);
    expect(manager.getStatus().compatibilityWarning).toBe(restarted.compatibilityWarning);
    expect(store.getWorkspace()).toEqual(workspace);
    expect((await manager.stop()).compatibilityWarning).toBeUndefined();
  });
  it('warns but reaches ready when version detection fails', async () => {
    await store.saveSettings({ executablePath: await serverFixture(false, 0, 'unknown') });
    const events = new Events();
    const log = vi.spyOn(events, 'log');
    manager = new ProcessManager(store, events, { healthIntervalMs: 10 });
    const status = await manager.launch('model');
    expect(status.compatibilityWarning).toContain('Could not verify executable version');
    await vi.waitFor(() => expect(manager!.getStatus().phase).toBe('ready'));
    expect(manager.getStatus().compatibilityWarning).toBe(status.compatibilityWarning);
    expect(log).toHaveBeenCalledWith(status.compatibilityWarning);
  });
  it('keeps one executable and workspace snapshot while settings change during startup', async () => {
    const original = await serverFixture(false, 0, '1', 250);
    const replacement = await serverFixture(false, 0, '2');
    await store.saveSettings({ executableOverrides: { base: original } });
    await store.saveWorkspace({ ...store.getWorkspace(), llamaVersion: '1' });
    manager = new ProcessManager(store, new Events(), { healthIntervalMs: 10 });
    const launching = manager.launch('model');
    await vi.waitFor(async () => expect(await readFile(join(directory, 'help-started.txt'), 'utf8')).toBe(original));
    await store.saveSettings({ executableOverrides: { base: replacement } });
    await store.saveWorkspace({ ...store.getWorkspace(), llamaVersion: '2' });
    expect((await launching).compatibilityWarning).toBeUndefined();
    await vi.waitFor(() => expect(manager!.getStatus().phase).toBe('ready'));
    expect(await readFile(join(directory, 'executable.txt'), 'utf8')).toBe(original);
    expect((await manager.restart()).compatibilityWarning).toBeUndefined();
    await vi.waitFor(() => expect(manager!.getStatus().phase).toBe('ready'));
    expect(await readFile(join(directory, 'executable.txt'), 'utf8')).toBe(replacement);
  });
  it('does not mark spawn ready, polls /health and serializes stop/restart while awaiting exit', async () => {
    vi.stubEnv('HF_TOKEN', 'hf_private');
    const path = await serverFixture(true);
    await store.saveSettings({ executablePath: path, hfToken: 'hf_private' });
    const events = new Events();
    const log = vi.spyOn(events, 'log');
    manager = new ProcessManager(store, events, { stopTimeoutMs: 100, healthIntervalMs: 20, readyTimeoutMs: 5000 });
    const started = await manager.launch('model');
    expect(started.phase).toBe('starting');
    await vi.waitFor(() => expect(manager!.getStatus().phase).toBe('ready'), { timeout: 5000 });
    const originalPid = manager.getStatus().pid!;
    const args = JSON.parse(await readFile(join(directory, 'args.json'), 'utf8')) as string[];
    expect(args).toContain('--metrics');
    expect(args).toContain(join(directory, 'models/model.gguf'));
    expect(args).toContain('127.0.0.1');
    expect(args).not.toContain('--load-mode');
    expect(JSON.parse(await readFile(join(directory, 'environment.json'), 'utf8'))).toEqual({ hf: null });
    expect(log.mock.calls.some(([line]) => line.includes('implicit --load-mode'))).toBe(true);
    await expect(manager.launch('model')).rejects.toThrow('Stop the current');
    const restarted = await manager.restart();
    expect(restarted.phase).toBe('starting');
    expect(restarted.pid).not.toBe(originalPid);
    expect(() => process.kill(originalPid, 0)).toThrow();
    await vi.waitFor(() => expect(manager!.getStatus().phase).toBe('ready'), { timeout: 5000 });
    const secondPid = manager.getStatus().pid!;
    expect((await manager.stop()).phase).toBe('stopped');
    expect(() => process.kill(secondPid, 0)).toThrow();
  });
  it('rejects explicitly selected unsupported flags with actionable guidance', async () => {
    await store.saveSettings({ executablePath: await serverFixture() });
    await store.saveWorkspace({ ...store.getWorkspace(), base: { loadMode: 'mlock' } });
    manager = new ProcessManager(store, new Events());
    await expect(manager.launch('model')).rejects.toThrow('Clear the explicit override');
    expect(manager.getStatus().phase).toBe('stopped');
  });
  it('never silently disables an explicit option whose implicit dependency is unsupported', async () => {
    await store.saveSettings({ executablePath: await serverFixture() });
    await store.saveWorkspace({ ...store.getWorkspace(), base: { chatTemplateKwargs: '{"enable_thinking":false}' } });
    manager = new ProcessManager(store, new Events());
    await expect(manager.launch('model')).rejects.toThrow('requires Jinja');
  });
  it('does not mistake an already-running service for readiness of its own child', async () => {
    const occupied = createServer();
    occupied.listen(port, '127.0.0.1');
    await once(occupied, 'listening');
    try {
      await store.saveSettings({ executablePath: await serverFixture() });
      manager = new ProcessManager(store, new Events());
      await expect(manager.launch('model')).rejects.toThrow('already in use');
      expect(manager.getStatus().phase).toBe('stopped');
    } finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
  });
  it('preview resolves inherited args and model path without a capability probe', async () => {
    const path = await fixture(`throw new Error('must never execute in preview');`);
    await store.saveSettings({ executablePath: path });
    const workspace = store.getWorkspace();
    workspace.base = { temperature: 0.2 };
    workspace.groups = [{ id: 'group', name: 'Group', values: { temperature: 0.4 } }];
    workspace.models[0]!.groupId = 'group';
    workspace.models[0]!.values = { temperature: 0.6 };
    await store.saveWorkspace(workspace);
    manager = new ProcessManager(store, new Events());
    const preview = await manager.preview('model');
    expect(preview.args[preview.args.indexOf('--temp') + 1]).toBe('0.6');
    expect(preview.args).toContain(join(directory, 'models/model.gguf'));
  });
  it('terminates children on readiness timeout and reports failure', async () => {
    await store.saveSettings({ executablePath: await serverFixture(true, 10000) });
    manager = new ProcessManager(store, new Events(), { readyTimeoutMs: 100, healthIntervalMs: 10, stopTimeoutMs: 50 });
    const status = await manager.launch('model');
    await vi.waitFor(() => expect(manager!.getStatus().phase).toBe('failed'));
    await vi.waitFor(() => expect(() => process.kill(status.pid!, 0)).toThrow());
    expect(manager.getStatus().error).toContain('readiness timeout');
  });
  it('records unexpected child exit as failed and permits subsequent launch', async () => {
    const path = await fixture(`if (process.argv.includes('--help')) { console.log('--model --host --port'); } else { process.exitCode = 7; }`);
    await store.saveSettings({ executablePath: path });
    manager = new ProcessManager(store, new Events(), { healthIntervalMs: 10 });
    await manager.launch('model');
    await vi.waitFor(() => expect(manager!.getStatus().phase).toBe('failed'));
    expect(manager.getStatus().error).toContain('7');
    expect((await manager.stop()).phase).toBe('stopped');
  });
});
