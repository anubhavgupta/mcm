import type { ExecutableScope, LocalSettings, Workspace } from './types';

export function executableOverride(settings: Pick<LocalSettings, 'executableOverrides'>, scope: ExecutableScope): string | undefined {
  const overrides = settings.executableOverrides;
  if (scope.kind === 'base') return overrides?.base;
  const entries = scope.kind === 'model' ? overrides?.models : overrides?.groups;
  return entries && Object.hasOwn(entries, scope.id) ? entries[scope.id] : undefined;
}

export function resolveExecutable(settings: Pick<LocalSettings, 'executablePath' | 'executableOverrides'>, workspace: Workspace, scope: ExecutableScope): string {
  const own = executableOverride(settings, scope);
  if (own) return own;
  if (scope.kind === 'model') {
    const model = workspace.models.find(item => item.id === scope.id);
    const group = model?.groupId ? executableOverride(settings, { kind: 'group', id: model.groupId }) : undefined;
    if (group) return group;
  }
  return executableOverride(settings, { kind: 'base' }) || settings.executablePath;
}

export function expectedLlamaVersion(workspace: Workspace, scope: ExecutableScope): string | undefined {
  if (scope.kind === 'model') {
    const model = workspace.models.find(item => item.id === scope.id);
    const group = workspace.groups.find(item => item.id === model?.groupId);
    return model?.llamaVersion ?? group?.llamaVersion ?? workspace.llamaVersion;
  }
  if (scope.kind === 'group') return workspace.groups.find(item => item.id === scope.id)?.llamaVersion ?? workspace.llamaVersion;
  return workspace.llamaVersion;
}

export function versionWarning(expected: string | undefined, actual: string): string | undefined {
  return expected && expected !== actual
    ? `Configuration was saved for llama.cpp ${expected}, but this executable reports ${actual}. Flags and supported values may differ.`
    : undefined;
}
