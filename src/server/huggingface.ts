import { uploadFiles } from '@huggingface/hub';
import { repoSchema, workspaceSchema } from '../shared/config';
import { modelWorkspace } from '../shared/sharing';
import type { Workspace } from '../shared/types';
import { ApiError } from './errors';
import { Store } from './storage';

const HUB = 'https://huggingface.co';
const FILE = 'mcm/workspace.json';
export interface HubOptions {
  fetch?: typeof fetch;
  upload?: typeof uploadFiles;
}

export class HuggingFace {
  constructor(private store: Store, private options: HubOptions = {}) {}
  private repo(requested?: string): string {
    const repo = requested ?? this.store.getSettings().hfRepo;
    const result = repoSchema.safeParse(repo);
    if (!result.success) throw new ApiError(400, 'Choose an existing Hugging Face dataset repository (owner/repository).');
    return result.data;
  }
  private safeFetch: typeof fetch = async (input, init) => {
    let url = new URL(input instanceof Request ? input.url : String(input));
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (url.origin !== HUB) throw new ApiError(502, 'Hugging Face requested an untrusted host.');
      const response = await (this.options.fetch ?? fetch)(url, { ...init, redirect: 'manual' });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new ApiError(502, 'Hugging Face returned an invalid redirect.');
      url = new URL(location, url);
    }
    throw new ApiError(502, 'Hugging Face returned too many redirects.');
  };
  async push(requested?: string, modelId?: string): Promise<{ url: string }> {
    const repo = this.repo(requested);
    const token = this.store.getSettings().hfToken;
    if (!token) throw new ApiError(400, 'Configure a Hugging Face write token in Machine settings before pushing.');
    const workspace = this.store.getWorkspace();
    if (modelId && !workspace.models.some(model => model.id === modelId)) throw new ApiError(404, 'Selected model configuration not found.');
    const shared = modelId ? modelWorkspace(workspace, modelId) : workspace;
    try {
      await (this.options.upload ?? uploadFiles)({
        repo: { type: 'dataset', name: repo },
        files: [{ path: FILE, content: new Blob([JSON.stringify(workspaceSchema.parse(shared), null, 2)], { type: 'application/json' }) }],
        accessToken: token, hubUrl: HUB, fetch: this.safeFetch,
        commitTitle: 'Update MCM workspace', abortSignal: AbortSignal.timeout(30000), useXet: false,
      });
      return { url: `${HUB}/datasets/${repo}/blob/main/${FILE}` };
    } catch {
      throw new ApiError(502, 'Hugging Face push failed. Check that the dataset repository exists and the token has write access.');
    }
  }
  async pull(requested?: string): Promise<{ workspace: Workspace }> {
    const repo = this.repo(requested);
    const token = this.store.getSettings().hfToken;
    try {
      const response = await this.safeFetch(`${HUB}/datasets/${repo}/resolve/main/${FILE}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ApiError(502, `Hugging Face pull failed (HTTP ${response.status}). Check the repository, file and read permissions.`);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new ApiError(502, 'Hugging Face returned an empty response.');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2 * 1024 * 1024) {
            await reader.cancel();
            throw new ApiError(502, 'Hugging Face workspace exceeds the 2 MiB limit.');
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      return { workspace: workspaceSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))) };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, 'Hugging Face pull failed or the workspace is invalid. Check the repository, file and read permissions.');
    }
  }
}
