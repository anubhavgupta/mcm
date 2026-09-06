import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { relativeBinding, Store, syncDirectory } from './storage';
import { discoverModels, resolveModel } from './models';
import { emptyWorkspace } from '../shared/config';

let directory: string;
let store: Store;
beforeEach(async () => {
  directory = resolve(`src/server/.test-data-${randomUUID()}`);
  store = new Store(join(directory, 'data'));
  await store.init();
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('private atomic persistence', () => {
  it('migrates absent translation mode to passthrough and preserves an opt-in across unrelated updates/restarts', async () => {
    const { anthropicMode: _mode, ...legacy } = store.getSettings();
    await writeFile(join(directory, 'data/settings.json'), JSON.stringify(legacy));
    const restored = new Store(join(directory, 'data'));
    await restored.init();
    expect(restored.publicSettings().anthropicMode).toBe('passthrough');
    await restored.saveSettings({ anthropicMode: 'openai' });
    await restored.saveSettings({ serverPort: 9001 });
    await restored.saveSettings({ hfToken: 'private-token' });
    const reopened = new Store(join(directory, 'data'));
    await reopened.init();
    expect(reopened.publicSettings().anthropicMode).toBe('openai');
    await expect(reopened.saveSettings({ anthropicMode: 'invalid' })).rejects.toThrow();
    expect(reopened.publicSettings().anthropicMode).toBe('openai');
  });
  it('migrates legacy persisted prices to ordinary overrides without losing explicit zero', async () => {
    await writeFile(join(directory, 'data/workspace.json'), JSON.stringify({
      ...emptyWorkspace(),
      basePricing: { inputUsdPerMillion: 0.5, outputUsdPerMillion: 3 },
      models: [{
        id: 'one', name: 'One', model: { filename: 'one.gguf' }, values: { temperature: 0.6 },
        pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 4 },
      }],
    }));
    const restored = new Store(join(directory, 'data'));
    await restored.init();
    const workspace = restored.getWorkspace();
    expect(workspace.base).toEqual({ inputUsdPerMillion: 0.5, outputUsdPerMillion: 3 });
    expect(workspace.models[0].values).toEqual({ temperature: 0.6, inputUsdPerMillion: 0, outputUsdPerMillion: 4 });
    expect(workspace).not.toHaveProperty('basePricing');
    expect(workspace.models[0]).not.toHaveProperty('pricing');
    await restored.saveWorkspace(workspace);
    expect(JSON.parse(await readFile(join(directory, 'data/workspace.json'), 'utf8'))).toEqual(workspace);
  });
  it('skips unsupported Windows directory fsync but retains POSIX errors and durability', async () => {
    const missing = join(directory, 'nonexistent-directory');
    await expect(syncDirectory(missing, 'win32')).resolves.toBeUndefined();
    await expect(syncDirectory(missing, 'linux')).rejects.toMatchObject({ code: 'ENOENT' });
    if (process.platform !== 'win32') {
      await expect(syncDirectory(join(directory, 'data'), process.platform)).resolves.toBeUndefined();
    }
  });
  it('rejects Windows drive and alternate-stream paths independently of the host platform', () => {
    for (const binding of ['C:/x.gguf', 'C:x.gguf', 'nested/x:stream.gguf', 'C:\\x.gguf']) {
      expect(relativeBinding.safeParse(binding).success).toBe(false);
    }
    expect(relativeBinding.safeParse('nested/model.gguf').success).toBe(true);
  });
  it('persists independent documents with owner-only modes and private tokens', async () => {
    const workspace = { ...emptyWorkspace(), base: { temperature: 0.3 } };
    await Promise.all([store.saveWorkspace(workspace), store.saveSettings({ hfToken: 'hf_private', hfRepo: 'owner/config' })]);
    const restored = new Store(join(directory, 'data'));
    await restored.init();
    expect(restored.getWorkspace()).toEqual(workspace);
    expect(restored.publicSettings()).toMatchObject({ hfTokenConfigured: true, hfRepo: 'owner/config' });
    expect(JSON.stringify(restored.publicSettings())).not.toContain('hf_private');
    expect(await readFile(join(directory, 'data/workspace.json'), 'utf8')).not.toContain('hf_private');
    expect((await stat(join(directory, 'data/settings.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, 'data/workspace.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, 'data'))).mode & 0o777).toBe(0o700);
    await restored.saveSettings({ hfToken: '' });
    expect(restored.publicSettings().hfTokenConfigured).toBe(true);
    await restored.saveSettings({ clearHfToken: true });
    expect(restored.publicSettings().hfTokenConfigured).toBe(false);
  });
  it('rejects invalid updates without changing persisted state', async () => {
    await expect(store.saveWorkspace({ ...emptyWorkspace(), version: 2 })).rejects.toThrow();
    await expect(store.saveSettings({ serverPort: 1 })).rejects.toThrow();
    await expect(store.saveSettings({ upstreamUrl: 'http://user:password@localhost:8080' })).rejects.toThrow();
    await expect(store.saveSettings({ modelBindings: { model: '../escape.gguf' } })).rejects.toThrow();
    await expect(store.saveSettings({ modelBindings: { model: '/escape.gguf' } })).rejects.toThrow();
    expect(store.getWorkspace()).toEqual(emptyWorkspace());
  });
  it('serializes partial settings updates without lost writes and rejects corrupt disk data', async () => {
    await Promise.all([store.saveSettings({ hfRepo: 'owner/repo' }), store.saveSettings({ serverPort: 9000 })]);
    expect(store.publicSettings()).toMatchObject({ hfRepo: 'owner/repo', serverPort: 9000 });
    await writeFile(join(directory, 'data/settings.json'), '{broken');
    await expect(new Store(join(directory, 'data')).init()).rejects.toThrow('Cannot load settings.json');
  });
});

describe('safe model discovery and resolution', () => {
  it('discovers nested GGUF files, rejects ambiguous names and respects relative bindings', async () => {
    const models = join(directory, 'models');
    await mkdir(join(models, 'a'), { recursive: true });
    await mkdir(join(models, 'b'));
    await writeFile(join(models, 'a/model.gguf'), 'gguf');
    await writeFile(join(models, 'b/model.gguf'), 'gguf');
    await writeFile(join(models, 'other.txt'), 'not a model');
    await store.saveSettings({ modelsDirectory: models });
    const model = { id: 'one', name: 'One', model: { filename: 'model.gguf' }, values: {} };
    expect(await discoverModels(models)).toHaveLength(2);
    await expect(resolveModel(store.getSettings(), model)).rejects.toThrow('Multiple files');
    await store.saveSettings({ modelBindings: { one: 'b/model.gguf' } });
    expect(await resolveModel(store.getSettings(), model)).toBe(join(models, 'b/model.gguf'));
    await expect(resolveModel(store.getSettings(), { ...model, id: 'two', model: { filename: 'missing.gguf' } })).rejects.toThrow('not found');
  });
  it('never follows symlinks and reports missing or unreadable directories', async () => {
    const models = join(directory, 'models');
    await mkdir(models);
    await writeFile(join(directory, 'outside.gguf'), 'secret');
    await symlink(join(directory, 'outside.gguf'), join(models, 'escape.gguf'));
    await symlink(directory, join(models, 'cycle'));
    expect(await discoverModels(models)).toEqual([]);
    await store.saveSettings({ modelsDirectory: models, modelBindings: { one: 'escape.gguf' } });
    await expect(resolveModel(store.getSettings(), { id: 'one', name: 'One', model: { filename: 'escape.gguf' }, values: {} })).rejects.toThrow('missing or unsafe');
    await expect(discoverModels(join(directory, 'absent'))).rejects.toThrow('missing or unreadable');
  });
});
