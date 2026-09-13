import { workspaceSchema } from './config';
import type { Workspace } from './types';

const MAX_SHARE_BYTES = 48_000;

export function modelWorkspace(workspace: Workspace, modelId: string): Workspace {
  const model = workspace.models.find(item => item.id === modelId);
  if (!model) throw new Error('Selected model configuration not found.');
  return workspaceSchema.parse({
    version: workspace.version,
    base: workspace.base,
    ...(workspace.llamaVersion ? { llamaVersion: workspace.llamaVersion } : {}),
    ...(workspace.basePricing ? { basePricing: workspace.basePricing } : {}),
    groups: workspace.groups.filter(group => group.id === model.groupId),
    models: [model],
  });
}

export function encodeWorkspace(workspace: Workspace): string {
  const bytes = new TextEncoder().encode(JSON.stringify(workspaceSchema.parse(workspace)));
  if (bytes.length > MAX_SHARE_BYTES) throw new Error('This workspace is too large for a link. Use JSON export or Hugging Face instead.');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function decodeWorkspace(payload: string): Workspace {
  if (payload.length > MAX_SHARE_BYTES * 4 / 3 || !/^[A-Za-z0-9_-]+$/.test(payload)) {
    throw new Error('Invalid or oversized configuration link.');
  }
  try {
    const binary = atob(payload.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return workspaceSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch (error) {
    throw new Error('The shared configuration is invalid or uses an unsupported schema.', { cause: error });
  }
}

export function createShareUrl(workspace: Workspace, appUrl: string): string {
  const url = new URL(appUrl);
  url.hash = `config=${encodeWorkspace(workspace)}`;
  url.search = '';
  return url.toString();
}
