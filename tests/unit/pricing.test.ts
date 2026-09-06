import { describe, expect, it } from 'vitest';
import { buildArgs, defaults, emptyWorkspace, resolvePricing, workspaceSchema } from '../../src/shared/config';
import { decodeWorkspace, encodeWorkspace, modelWorkspace } from '../../src/shared/sharing';
import type { Workspace } from '../../src/shared/types';

const model = {
  id: 'priced', name: 'Priced model', model: { filename: 'priced.gguf' }, values: {},
  pricing: { inputUsdPerMillion: 1.5, outputUsdPerMillion: 6 },
};

describe('hierarchical portable token pricing', () => {
  it('migrates and shares legacy prices as ordinary configuration values', () => {
    const workspace: Workspace = {
      ...emptyWorkspace(), basePricing: { inputUsdPerMillion: 0.5, outputUsdPerMillion: 3 }, models: [model],
    };
    const shared = decodeWorkspace(encodeWorkspace(modelWorkspace(workspace, model.id)));
    expect(shared.base).toEqual(workspace.basePricing);
    expect(shared.models[0].values).toEqual(model.pricing);
    expect(shared).not.toHaveProperty('basePricing');
    expect(shared.models[0]).not.toHaveProperty('pricing');
    expect(workspaceSchema.safeParse({ ...workspace, basePricing: { inputUsdPerMillion: -1, outputUsdPerMillion: 3 } }).success).toBe(false);
  });
  it('allows existing configurations without pricing and explicit free pricing', () => {
    const { pricing: _pricing, ...unpriced } = model;
    expect(workspaceSchema.parse({ ...emptyWorkspace(), models: [unpriced] }).models[0]).not.toHaveProperty('pricing');
    expect(workspaceSchema.parse({
      ...emptyWorkspace(), models: [{ ...model, pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } }],
    }).models[0].values).toEqual({ inputUsdPerMillion: 0, outputUsdPerMillion: 0 });
  });

  it.each([
    { inputUsdPerMillion: -1, outputUsdPerMillion: 2 },
    { inputUsdPerMillion: 1, outputUsdPerMillion: -2 },
    { inputUsdPerMillion: '1', outputUsdPerMillion: 2 },
    { inputUsdPerMillion: 1 },
    { inputUsdPerMillion: NaN, outputUsdPerMillion: 2 },
    { inputUsdPerMillion: 1, outputUsdPerMillion: Infinity },
    { inputUsdPerMillion: 1, outputUsdPerMillion: 2, currency: 'EUR' },
  ])('rejects incomplete or invalid prices %j', pricing => {
    expect(workspaceSchema.safeParse({ ...emptyWorkspace(), models: [{ ...model, pricing }] }).success).toBe(false);
  });

  it('round-trips pricing in selected-model links without adding executable flags', () => {
    const workspace: Workspace = { ...emptyWorkspace(), models: [model] };
    const selected = modelWorkspace(workspace, model.id);
    expect(decodeWorkspace(encodeWorkspace(selected)).models[0].values).toEqual(model.pricing);
    expect(buildArgs(defaults).join(' ')).not.toContain('UsdPerMillion');
  });
  it('inherits each price independently through base, group and model, including zero', () => {
    const workspace = workspaceSchema.parse({
      ...emptyWorkspace(), base: { inputUsdPerMillion: 1, outputUsdPerMillion: 3 },
      groups: [{ id: 'group', name: 'Group', values: { outputUsdPerMillion: 4 } }],
      models: [{ id: 'one', name: 'One', model: { filename: 'one.gguf' }, groupId: 'group', values: { inputUsdPerMillion: 0 } }],
    });
    expect(resolvePricing(workspace, workspace.models[0])).toEqual({ inputUsdPerMillion: 0, outputUsdPerMillion: 4 });
    delete workspace.models[0].values.inputUsdPerMillion;
    expect(resolvePricing(workspace, workspace.models[0])).toEqual({ inputUsdPerMillion: 1, outputUsdPerMillion: 4 });
    delete workspace.models[0].groupId;
    expect(resolvePricing(workspace, workspace.models[0])).toEqual({ inputUsdPerMillion: 1, outputUsdPerMillion: 3 });
    expect(resolvePricing(emptyWorkspace())).toEqual({ inputUsdPerMillion: 0.25, outputUsdPerMillion: 2 });
  });
  it('prefers new values over legacy fields and migration is idempotent', () => {
    const workspace = workspaceSchema.parse({
      ...emptyWorkspace(), basePricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
      base: { inputUsdPerMillion: 0.5 },
      models: [{ ...model, values: { outputUsdPerMillion: 0 } }],
    });
    expect(workspace.base).toEqual({ inputUsdPerMillion: 0.5, outputUsdPerMillion: 2 });
    expect(workspace.models[0].values).toEqual({ inputUsdPerMillion: 1.5, outputUsdPerMillion: 0 });
    expect(workspaceSchema.parse(workspace)).toEqual(workspace);
  });
  it.each([{ inputUsdPerMillion: -1 }, { outputUsdPerMillion: '2' }, { inputUsdPerMillion: Infinity }])('validates price overrides %j', values => {
    expect(workspaceSchema.safeParse({ ...emptyWorkspace(), base: values }).success).toBe(false);
  });
});
