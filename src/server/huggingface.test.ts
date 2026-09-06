import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { rm } from 'node:fs/promises';
import { Store } from './storage';
import { HuggingFace } from './huggingface';
import { emptyWorkspace } from '../shared/config';
import type { uploadFiles } from '@huggingface/hub';

let directory: string;
let store: Store;
beforeEach(async () => {
  directory = resolve(`src/server/.test-data-${randomUUID()}`);
  store = new Store(directory);
  await store.init();
  await store.saveSettings({ hfRepo: 'owner/config' });
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('Hugging Face portable workspace exchange', () => {
  it('pulls public repositories without auth and returns a preview without overwriting', async () => {
    const workspace = { ...emptyWorkspace(), base: { temperature: 0.1 } };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(workspace)));
    const hub = new HuggingFace(store, { fetch: fetcher });
    expect(await hub.pull()).toEqual({ workspace });
    expect(store.getWorkspace()).toEqual(emptyWorkspace());
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://huggingface.co/datasets/owner/config/resolve/main/mcm/workspace.json');
    expect(fetcher.mock.calls[0]![1]?.headers).toEqual({});
  });
  it('follows bounded same-host redirects but never sends tokens to an external redirect', async () => {
    await store.saveSettings({ hfToken: 'hf_secret' });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: '/api/resolve-cache/safe' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(emptyWorkspace())));
    const hub = new HuggingFace(store, { fetch: fetcher });
    await hub.pull();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]![1]?.headers).toEqual({ Authorization: 'Bearer hf_secret' });
    fetcher.mockReset().mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'https://attacker.example/steal' } }));
    await expect(hub.pull()).rejects.toThrow('untrusted host');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('uploads only validated workspace JSON to an existing dataset using the official SDK', async () => {
    await store.saveSettings({ hfToken: 'hf_secret' });
    const upload = vi.fn<typeof uploadFiles>().mockResolvedValue(undefined);
    const hub = new HuggingFace(store, { upload });
    expect(await hub.push()).toEqual({ url: 'https://huggingface.co/datasets/owner/config/blob/main/mcm/workspace.json' });
    const input = upload.mock.calls[0]![0];
    expect(input.repo).toEqual({ type: 'dataset', name: 'owner/config' });
    expect(input.accessToken).toBe('hf_secret');
    const file = input.files[0] as { path: string; content: Blob };
    expect(file.path).toBe('mcm/workspace.json');
    expect(JSON.parse(await file.content.text())).toEqual(emptyWorkspace());
    expect(await file.content.text()).not.toContain('hf_secret');
    await store.saveSettings({ clearHfToken: true });
    await expect(hub.push()).rejects.toThrow('write token');
  });
  it('surfaces bounded, private upstream failures and rejects invalid or oversized workspaces', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('private data', { status: 401 }));
    const hub = new HuggingFace(store, { fetch: fetcher });
    await expect(hub.pull()).rejects.toThrow('HTTP 401');
    fetcher.mockResolvedValue(new Response('{"version":9}'));
    await expect(hub.pull()).rejects.toThrow('workspace is invalid');
    fetcher.mockResolvedValue(new Response('x'.repeat(2 * 1024 * 1024 + 1)));
    await expect(hub.pull()).rejects.toThrow('2 MiB limit');
  });
});
