import { describe, expect, it } from 'vitest';
import {
  buildArgs, catalog, defaults, emptyWorkspace, fieldError, isFieldEnabled,
  resolveConfig, workspaceSchema,
} from '../../src/shared/config';
import { decodeWorkspace, encodeWorkspace } from '../../src/shared/sharing';

const speculation = catalog.fields.find(field => field.key === 'speculation')!;
const draft = catalog.fields.find(field => field.key === 'draftModel')!;
const draftMax = catalog.fields.find(field => field.key === 'draftMax')!;
const resolved = { draftModel: '/models/draft model.gguf' };

describe('ordered multi-method speculation', () => {
  it('accepts existing single-mode settings and explicit none unchanged', () => {
    for (const value of ['none', 'ngram-mod', 'draft-mtp']) {
      expect(fieldError(speculation, value)).toBeUndefined();
      expect(workspaceSchema.parse({ ...emptyWorkspace(), base: { speculation: value } }).base.speculation).toBe(value);
    }
  });
  it('preserves requested order through hierarchy and share round trips', () => {
    const workspace = workspaceSchema.parse({
      ...emptyWorkspace(),
      base: { speculation: 'ngram-mod,draft-mtp' },
      groups: [{ id: 'group', name: 'Group', values: { speculation: 'draft-mtp,ngram-mod,ngram-simple' } }],
      models: [{ id: 'model', name: 'Model', model: { filename: 'main.gguf' }, groupId: 'group', values: {} }],
    });
    const shared = decodeWorkspace(encodeWorkspace(workspace));
    expect(resolveConfig(shared, shared.models[0]).speculation).toBe('draft-mtp,ngram-mod,ngram-simple');
    shared.models[0].values.speculation = 'none';
    expect(buildArgs(resolveConfig(shared, shared.models[0]))).not.toContain('--spec-type');
    delete shared.models[0].values.speculation;
    const args = buildArgs(resolveConfig(shared, shared.models[0]));
    expect(args.slice(args.indexOf('--spec-type'), args.indexOf('--spec-type') + 2))
      .toEqual(['--spec-type', 'draft-mtp,ngram-mod,ngram-simple']);
  });
  it.each(['', 'none,ngram-mod', 'draft-mtp,draft-mtp', 'ngram-mod,', ' ng ram', 'unknown', ['ngram-mod']])('rejects invalid method lists %j', value => {
    expect(fieldError(speculation, value)).toBeDefined();
  });
  it.each(['draft-simple', 'draft-eagle3', 'draft-dflash', 'draft-dspark'])('requires a local draft model for %s', method => {
    const values = { ...defaults, speculation: `ngram-mod,${method}` };
    expect(isFieldEnabled(draft, values)).toBe(true);
    expect(isFieldEnabled(draftMax, values)).toBe(true);
    expect(() => buildArgs(values)).toThrow('Draft model is required');
  });
  it('does not require an external model for MTP and hides inactive draft settings', () => {
    expect(isFieldEnabled(draft, { speculation: 'ngram-mod,draft-mtp' })).toBe(false);
    expect(isFieldEnabled(draftMax, { speculation: 'ngram-mod,draft-mtp' })).toBe(true);
    expect(isFieldEnabled(draftMax, { speculation: 'ngram-mod' })).toBe(false);
    expect(buildArgs({ speculation: 'none', draftModel: 'draft.gguf', draftGpuLayers: 50, draftMax: 8 })).toEqual([]);
  });
  it('uses safe resolved draft paths and supported aliases without splitting spaces', () => {
    const args = buildArgs({
      speculation: 'draft-simple,ngram-mod', draftModel: 'draft model.gguf',
      draftGpuLayers: 0, draftCacheTypeK: 'q8_0', draftCacheTypeV: 'f16', draftMax: 8,
    }, ['--spec-type', '-md', '-ngld', '-ctkd', '-ctvd', '--spec-draft-n-max'], resolved);
    expect(args).toEqual([
      '--spec-type', 'draft-simple,ngram-mod', '-md', '/models/draft model.gguf',
      '--spec-draft-n-max', '8', '-ngld', '0', '-ctkd', 'q8_0', '-ctvd', 'f16',
    ]);
    expect(() => buildArgs({ speculation: 'draft-simple', draftModel: 'draft.gguf' })).toThrow('Resolve Draft model');
  });
  it.each(['/models/draft.gguf', 'C:\\draft.gguf', '../draft.gguf', 'file.txt'])('rejects nonportable draft identity %s', filename => {
    expect(workspaceSchema.safeParse({ ...emptyWorkspace(), base: { draftModel: filename } }).success).toBe(false);
  });
  it('rejects unsupported active draft flags rather than silently ignoring overrides', () => {
    expect(() => buildArgs({
      speculation: 'draft-simple', draftModel: 'draft model.gguf', draftGpuLayers: 5,
    }, ['--spec-type', '-md'], resolved)).toThrow('Draft GPU layers');
  });
  it('rejects contradictory n-gram bounds only while ngram-mod is active', () => {
    expect(() => buildArgs({ speculation: 'ngram-mod', ngramMin: 64, ngramMax: 32 })).toThrow('Minimum n-gram tokens');
    expect(buildArgs({ speculation: 'none', ngramMin: 64, ngramMax: 32 })).toEqual([]);
  });
});
