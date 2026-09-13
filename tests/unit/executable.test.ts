import { describe, expect, it } from 'vitest';
import { emptyWorkspace, workspaceSchema } from '../../src/shared/config';
import { expectedLlamaVersion, resolveExecutable, versionWarning } from '../../src/shared/executable';
import { decodeWorkspace, encodeWorkspace, modelWorkspace } from '../../src/shared/sharing';
import type { LocalSettings, Workspace } from '../../src/shared/types';

const workspace: Workspace = {
  ...emptyWorkspace(), llamaVersion: 'b100 (aaaa)',
  groups: [{ id: 'group', name: 'Group', values: {}, llamaVersion: 'b200 (bbbb)' }],
  models: [{ id: 'model', name: 'Model', model: { filename: 'model.gguf' }, groupId: 'group', values: {}, llamaVersion: 'b300 (cccc)' }],
};
const settings: Pick<LocalSettings, 'executablePath' | 'executableOverrides'> = {
  executablePath: '/machine/llama-server',
  executableOverrides: { base: '/base/llama-server', groups: { group: '/group/llama-server' }, models: { model: '/model/llama-server' } },
};

describe('local executable hierarchy and portable versions', () => {
  it.each(['constructor', 'toString', '__proto__'])('does not resolve inherited object properties as paths for %s', id => {
    const local = { executablePath: '/machine', executableOverrides: { groups: {}, models: {} } };
    expect(resolveExecutable(local, workspace, { kind: 'group', id })).toBe('/machine');
    expect(resolveExecutable(local, workspace, { kind: 'model', id })).toBe('/machine');
  });
  it('resolves model > group > base > machine independently of config values', () => {
    const local = structuredClone(settings);
    const scope = { kind: 'model', id: 'model' } as const;
    expect(resolveExecutable(local, workspace, scope)).toBe('/model/llama-server');
    delete local.executableOverrides!.models!.model;
    expect(resolveExecutable(local, workspace, scope)).toBe('/group/llama-server');
    delete local.executableOverrides!.groups!.group;
    expect(resolveExecutable(local, workspace, scope)).toBe('/base/llama-server');
    delete local.executableOverrides!.base;
    expect(resolveExecutable(local, workspace, scope)).toBe('/machine/llama-server');
  });
  it('resolves base and group without model overrides', () => {
    expect(resolveExecutable(settings, workspace, { kind: 'base' })).toBe('/base/llama-server');
    expect(resolveExecutable(settings, workspace, { kind: 'group', id: 'group' })).toBe('/group/llama-server');
    const noGroup = { ...workspace, models: [{ ...workspace.models[0], groupId: undefined }] };
    expect(resolveExecutable({ ...settings, executableOverrides: { base: '/base', groups: { group: '/group' } } }, noGroup, { kind: 'model', id: 'model' })).toBe('/base');
  });
  it('inherits expected versions and warns only when an expectation differs', () => {
    const shared = structuredClone(workspace);
    const scope = { kind: 'model', id: 'model' } as const;
    expect(expectedLlamaVersion(shared, scope)).toBe('b300 (cccc)');
    delete shared.models[0].llamaVersion;
    expect(expectedLlamaVersion(shared, scope)).toBe('b200 (bbbb)');
    delete shared.groups[0].llamaVersion;
    expect(expectedLlamaVersion(shared, scope)).toBe('b100 (aaaa)');
    expect(versionWarning('b100 (aaaa)', 'b200 (bbbb)')).toContain('Flags and supported values may differ');
    expect(versionWarning('b100 (aaaa)', 'b100 (aaaa)')).toBeUndefined();
    expect(versionWarning(undefined, 'b100 (aaaa)')).toBeUndefined();
  });
  it('shares version expectations but never the local override paths', () => {
    const restored = decodeWorkspace(encodeWorkspace(modelWorkspace(workspace, 'model')));
    expect(restored.llamaVersion).toBe(workspace.llamaVersion);
    expect(restored.groups[0].llamaVersion).toBe(workspace.groups[0].llamaVersion);
    expect(restored.models[0].llamaVersion).toBe(workspace.models[0].llamaVersion);
    expect(JSON.stringify(restored)).not.toContain('executable');
    expect(workspaceSchema.safeParse({ ...workspace, executableOverrides: settings.executableOverrides }).success).toBe(false);
  });
  it.each(['', 'line\nbreak', 'x'.repeat(257)])('rejects invalid version metadata %j', llamaVersion => {
    expect(workspaceSchema.safeParse({ ...workspace, llamaVersion }).success).toBe(false);
  });
});
