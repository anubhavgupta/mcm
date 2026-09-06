import { describe, expect, it } from 'vitest';
import { emptyWorkspace } from '../../src/shared/config';
import { createShareUrl, decodeWorkspace, encodeWorkspace, modelWorkspace } from '../../src/shared/sharing';
import { resolveConfig } from '../../src/shared/config';
import type { Workspace } from '../../src/shared/types';

const workspace: Workspace = {
  version: 1,
  base: { temperature: 0.4 },
  groups: [{ id: 'code', name: 'Code', values: { threads: 6 } }],
  models: [{
    id: 'model', name: 'Multilingual \u65e5\u672c\u8a9e', groupId: 'code',
    model: { filename: 'model.gguf', repo: 'owner/model-GGUF' },
    values: { topK: 0, jinja: false },
  }],
};

describe('portable deep-links', () => {
  it('shares only a selected model and its ancestors without changing effective values', () => {
    const full: Workspace = {
      ...workspace,
      groups: [...workspace.groups, { id: 'other', name: 'Other', values: {} }],
      models: [...workspace.models, { id: 'other', name: 'Other', model: { filename: 'other.gguf' }, values: {} }],
    };
    const selected = modelWorkspace(full, 'model');
    expect(selected.models).toEqual([workspace.models[0]]);
    expect(selected.groups).toEqual(workspace.groups);
    expect(resolveConfig(selected, selected.models[0])).toEqual(resolveConfig(full, full.models[0]));
    expect(modelWorkspace(full, 'other').groups).toEqual([]);
    expect(full.models).toHaveLength(2);
    expect(() => modelWorkspace(full, 'missing')).toThrow('not found');
  });
  it('round-trips the entire hierarchy and unicode labels', () => {
    expect(decodeWorkspace(encodeWorkspace(workspace))).toEqual(workspace);
  });

  it('uses only URL-safe characters', () => {
    expect(encodeWorkspace(workspace)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('puts data in the fragment, not a server-visible query', () => {
    const url = new URL(createShareUrl(workspace, 'http://localhost:7838/?old=value#old'));
    expect(url.search).toBe('');
    expect(url.hash.startsWith('#config=')).toBe(true);
    expect(decodeWorkspace(url.hash.slice('#config='.length))).toEqual(workspace);
  });

  it.each(['', '%invalid', 'e30', '!!!!', 'x'.repeat(70_000)])('rejects malformed or oversized data', data => {
    expect(() => decodeWorkspace(data)).toThrow();
  });

  it('rejects unsupported schema versions', () => {
    const payload = btoa(JSON.stringify({ ...emptyWorkspace(), version: 2 })).replace(/=+$/, '');
    expect(() => decodeWorkspace(payload)).toThrow('unsupported schema');
  });

  it('refuses oversized links with an actionable export alternative', () => {
    const large: Workspace = {
      ...emptyWorkspace(),
      models: Array.from({ length: 100 }, (_, index) => ({
        id: `model-${index}`, name: `Model ${index}`, model: { filename: 'model.gguf' },
        values: { chatTemplateKwargs: JSON.stringify({ text: 'x'.repeat(1000) }) },
      })),
    };
    expect(() => encodeWorkspace(large)).toThrow('Hugging Face');
  });
});
