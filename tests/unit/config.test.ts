import { describe, expect, it } from 'vitest';
import {
  buildArgs, catalog, defaults, emptyWorkspace, fieldError, fieldSupported,
  isFieldEnabled, parseHelp, resolveConfig, workspaceSchema,
} from '../../src/shared/config';
import type { Workspace } from '../../src/shared/types';

function fixture(): Workspace {
  return {
    version: 1,
    base: { temperature: 0.6, gpuLayers: 30, jinja: true },
    groups: [{ id: 'coding', name: 'Coding', values: { temperature: 0.2, contextSize: 32768 } }],
    models: [{
      id: 'coder', name: 'Coder', groupId: 'coding',
      model: { filename: 'coder-Q4_K_M.gguf', repo: 'example/coder-GGUF' },
      values: { temperature: 0, gpuLayers: 0, jinja: false },
    }],
  };
}

describe('configuration hierarchy', () => {
  it('resolves defaults < base < group < model, preserving false and zero', () => {
    const workspace = fixture();
    expect(resolveConfig(workspace, workspace.models[0])).toMatchObject({
      temperature: 0, gpuLayers: 0, jinja: false, contextSize: 32768, threads: defaults.threads,
    });
  });

  it('passes through base when no group is selected', () => {
    const workspace = fixture();
    delete workspace.models[0].groupId;
    workspace.models[0].values = {};
    expect(resolveConfig(workspace, workspace.models[0])).toEqual({ ...defaults, ...workspace.base });
  });

  it('resetting an override restores the next applicable ancestor', () => {
    const workspace = fixture();
    delete workspace.models[0].values.temperature;
    expect(resolveConfig(workspace, workspace.models[0]).temperature).toBe(0.2);
    delete workspace.groups[0].values.temperature;
    expect(resolveConfig(workspace, workspace.models[0]).temperature).toBe(0.6);
  });

  it('does not mutate any ancestor', () => {
    const workspace = fixture();
    const before = structuredClone(workspace);
    resolveConfig(workspace, workspace.models[0]).threads = 4;
    expect(workspace).toEqual(before);
  });
});

describe('schema and catalog', () => {
  it('accepts empty and populated workspaces', () => {
    expect(workspaceSchema.parse(emptyWorkspace())).toEqual(emptyWorkspace());
    expect(workspaceSchema.parse(fixture())).toEqual(fixture());
  });

  it('has valid defaults, unique keys, known sections, and valid dependencies', () => {
    const keys = catalog.fields.map(field => field.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const field of catalog.fields) {
      expect(fieldError(field, field.default), field.key).toBeUndefined();
      expect(catalog.sections.some(section => section.id === field.section)).toBe(true);
      if (field.dependsOn) {
        expect(keys).toContain(field.dependsOn.key);
        expect(field.dependsOn.key).not.toBe(field.key);
      }
    }
  });

  it.each([
    { temperature: -1 }, { topP: 2 }, { threads: 0 }, { threads: 1.5 },
    { temperature: Number.NaN }, { gpuLayers: '30' }, { verbose: 'true' },
    { cacheRam: -2 }, { reasoning: 'maybe' }, { unknownSetting: 123 },
    { chatTemplateKwargs: '{"bad"}' }, { chatTemplateKwargs: '[]' },
  ])('rejects invalid values %j', values => {
    expect(workspaceSchema.safeParse({ ...emptyWorkspace(), base: values }).success).toBe(false);
  });

  it('accepts supported sentinel values and JSON objects', () => {
    expect(workspaceSchema.safeParse({
      ...emptyWorkspace(),
      base: { cacheRam: -1, contextSize: 0, topK: 0, chatTemplateKwargs: '{"enable_thinking":false}' },
    }).success).toBe(true);
  });

  it('rejects unknown/private properties rather than persisting them in portable configs', () => {
    expect(workspaceSchema.safeParse({ ...fixture(), executablePath: '/private/llama-server' }).success).toBe(false);
    const workspace = fixture();
    expect(workspaceSchema.safeParse({
      ...workspace, models: [{ ...workspace.models[0], hfToken: 'not-a-real-token' }],
    }).success).toBe(false);
  });

  it.each(['/models/coder.gguf', 'C:\\models\\coder.gguf', '../coder.gguf', 'coder.txt'])('rejects a nonportable filename %s', filename => {
    const workspace = fixture();
    workspace.models[0].model.filename = filename;
    expect(workspaceSchema.safeParse(workspace).success).toBe(false);
  });

  it('rejects dangling groups and duplicate IDs', () => {
    const workspace = fixture();
    workspace.models[0].groupId = 'missing';
    expect(workspaceSchema.safeParse(workspace).success).toBe(false);
    workspace.models[0].groupId = 'coding';
    workspace.models.push(structuredClone(workspace.models[0]));
    expect(workspaceSchema.safeParse(workspace).success).toBe(false);
  });
});

describe('CLI serialization and capability discovery', () => {
  it('preserves zero rather than silently using executable defaults', () => {
    expect(buildArgs({ gpuLayers: 0, temperature: 0, topK: 0, cacheRam: 0 }))
      .toEqual(['--gpu-layers', '0', '--temp', '0', '--top-k', '0', '--cache-ram', '0']);
  });

  it('omits false flags, empty text, and explicitly disabled options', () => {
    expect(buildArgs({ verbose: false, speculation: 'none', chatTemplateKwargs: '' })).toEqual([]);
    expect(buildArgs({ verbose: true })).toEqual(['--verbose']);
  });

  it('applies dependencies to both UI and CLI using effective inherited values', () => {
    const keyField = catalog.fields.find(field => field.key === 'cacheTypeK')!;
    expect(isFieldEnabled(keyField, { customKv: false })).toBe(false);
    expect(buildArgs({ customKv: false, cacheTypeK: 'q8_0' })).toEqual([]);
    const workspace = fixture();
    workspace.base.customKv = true;
    workspace.models[0].values.cacheTypeK = 'q8_0';
    const effective = resolveConfig(workspace, workspace.models[0]);
    expect(isFieldEnabled(keyField, effective)).toBe(true);
    const args = buildArgs(effective);
    expect(args.slice(args.indexOf('--cache-type-k'), args.indexOf('--cache-type-k') + 2))
      .toEqual(['--cache-type-k', 'q8_0']);
  });

  it('uses an executable-supported alias and rejects unsupported active flags', () => {
    expect(buildArgs({ gpuLayers: 10 }, ['-ngl'])).toEqual(['-ngl', '10']);
    expect(() => buildArgs({ gpuLayers: 10 }, ['--threads'])).toThrow('not supported');
    expect(buildArgs({ verbose: false }, [])).toEqual([]);
    expect(fieldSupported(catalog.fields[0], ['--n-gpu-layers'])).toBe(true);
  });

  it('passes JSON and whitespace as single argv values without shell interpolation', () => {
    const json = '{"name":"a b","enable_thinking":false}';
    expect(buildArgs({ jinja: true, chatTemplateKwargs: json }))
      .toEqual(['--jinja', '--chat-template-kwargs', json]);
  });

  it('extracts unique flags from a real-style help listing', () => {
    expect(parseHelp('-t, --threads N\n-ngl, --gpu-layers N\n--threads N\n--metrics'))
      .toEqual(['--gpu-layers', '--metrics', '--threads', '-ngl', '-t']);
  });
});
