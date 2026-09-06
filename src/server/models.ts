import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { LocalSettings, ModelConfig, ModelFile } from '../shared/types';
import { ApiError } from './errors';
import { relativeBinding } from './storage';

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export async function discoverModels(directory: string): Promise<ModelFile[]> {
  if (!directory) throw new ApiError(400, 'Choose a models directory in Machine settings.');
  const models: ModelFile[] = [];
  let root: string;
  try { root = await realpath(directory); }
  catch { throw new ApiError(400, 'Models directory is missing or unreadable. Update Machine settings.'); }
  const visit = async (path: string, depth: number): Promise<void> => {
    if (depth > 32 || models.length > 10000) throw new ApiError(400, 'Models directory is too large or deeply nested.');
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const target = join(path, entry.name);
      const canonical = await realpath(target);
      if (!inside(root, canonical)) continue;
      if (entry.isDirectory()) await visit(target, depth + 1);
      else if (entry.isFile() && /\.gguf$/i.test(entry.name)) {
        const info = await stat(canonical);
        models.push({ filename: entry.name, relativePath: relative(root, canonical).split(sep).join('/'), size: info.size });
      }
    }
  };
  try { await visit(root, 0); }
  catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'Models directory contains unreadable files or directories.');
  }
  return models.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function resolveModel(settings: LocalSettings, model: ModelConfig): Promise<string> {
  const files = await discoverModels(settings.modelsDirectory);
  const binding = settings.modelBindings[model.id];
  let candidate: ModelFile | undefined;
  if (binding !== undefined) {
    if (!relativeBinding.safeParse(binding).success) throw new ApiError(400, 'Invalid model binding; choose a discovered GGUF file.');
    candidate = files.find(file => file.relativePath === binding);
    if (!candidate) throw new ApiError(400, `Binding for ${model.name} is missing or unsafe. Choose a discovered GGUF file in Machine settings.`);
  } else {
    const matches = files.filter(file => file.filename === basename(model.model.filename));
    if (matches.length !== 1) throw new ApiError(400, matches.length
      ? `Multiple files match ${model.model.filename}. Set a model binding in Machine settings.`
      : `${model.model.filename} was not found. Choose the models directory or set a model binding.`);
    candidate = matches[0];
  }
  const root = await realpath(settings.modelsDirectory);
  const path = await realpath(resolve(root, candidate!.relativePath));
  if (!inside(root, path)) throw new ApiError(400, 'Model path escapes the configured directory.');
  return path;
}
