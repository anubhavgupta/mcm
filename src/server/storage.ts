import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { emptyWorkspace, repoSchema, workspaceSchema } from '../shared/config';
import type { LocalSettings, PublicSettings, Workspace } from '../shared/types';

export const relativeBinding = z.string().min(1).max(4096).refine(value =>
  !isAbsolute(value) && !value.includes('\\') && !value.includes(':') && !value.includes('\0') &&
  !value.split('/').some(part => part === '..' || part === '.' || part === '') &&
  /\.gguf$/i.test(value), 'Use a discovered relative GGUF path inside the models directory.');
const pathString = z.string().max(4096).refine(value => !/[\x00-\x1f]/.test(value), 'Invalid path.');
const settingsShape = {
  executablePath: pathString,
  modelsDirectory: pathString,
  serverPort: z.number().int().min(1024).max(65535),
  upstreamUrl: z.string().max(4096).refine(value => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && (url.pathname === '/' || url.pathname === '');
    } catch { return false; }
  }, 'Use an HTTP(S) origin without credentials, path, query or fragment.'),
  modelBindings: z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), relativeBinding),
  hfRepo: z.union([z.literal(''), repoSchema]),
  hfToken: z.string().max(4096).refine(value => !/[\x00-\x20\x7f]/.test(value), 'Invalid token.').optional(),
};
export const settingsSchema = z.object(settingsShape).strict();
export const settingsUpdateSchema = z.object(settingsShape).partial().extend({ clearHfToken: z.boolean().optional() }).strict();
export const defaultSettings: LocalSettings = {
  executablePath: '', modelsDirectory: '', serverPort: 8080, upstreamUrl: '', modelBindings: {}, hfRepo: '',
};

export async function syncDirectory(path: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  // Node cannot reliably open/fsync directories on Windows. File fsync and atomic rename still apply,
  // but Windows does not receive the additional directory-entry crash-durability guarantee.
  if (platform === 'win32') return;
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function atomicJson(directory: string, name: string, data: unknown): Promise<void> {
  const path = join(directory, `.${name}.${randomUUID()}`);
  const file = await open(path, 'wx', 0o600);
  let closed = false;
  try {
    await file.writeFile(JSON.stringify(data, null, 2));
    await file.sync();
    await file.close();
    closed = true;
    await rename(path, join(directory, name));
    await syncDirectory(directory);
  } finally {
    try {
      if (!closed) await file.close().catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EBADF') throw error;
      });
    } finally {
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
}

export class Store {
  private workspace: Workspace = emptyWorkspace();
  private settings: LocalSettings = structuredClone(defaultSettings);
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    this.workspace = await this.load('workspace.json', workspaceSchema, emptyWorkspace());
    this.settings = await this.load('settings.json', settingsSchema, structuredClone(defaultSettings));
  }
  private async load<T>(name: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
    const path = join(this.directory, name);
    try {
      await chmod(path, 0o600);
      return schema.parse(JSON.parse(await readFile(path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Cannot load ${name}: invalid or unreadable persisted data.`, { cause: error });
      await this.atomic(name, fallback);
      return fallback;
    }
  }
  private async atomic(name: string, data: unknown): Promise<void> {
    await atomicJson(this.directory, name, data);
  }
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(fn);
    this.queue = operation.catch(() => {});
    return operation;
  }
  getWorkspace(): Workspace { return structuredClone(this.workspace); }
  getSettings(): LocalSettings { return structuredClone(this.settings); }
  publicSettings(): PublicSettings {
    const { hfToken, ...settings } = this.getSettings();
    return { ...settings, hfTokenConfigured: Boolean(hfToken) };
  }
  redact(text: string): string {
    const token = this.settings.hfToken;
    return token ? text.split(token).join('[REDACTED]') : text;
  }
  async saveWorkspace(input: unknown): Promise<Workspace> {
    const workspace = workspaceSchema.parse(input);
    return this.serialize(async () => {
      await this.atomic('workspace.json', workspace);
      this.workspace = workspace;
      return this.getWorkspace();
    });
  }
  async saveSettings(input: unknown): Promise<PublicSettings> {
    const patch = settingsUpdateSchema.parse(input);
    return this.serialize(async () => {
      const { clearHfToken, hfToken, ...rest } = patch;
      const next = settingsSchema.parse({ ...this.settings, ...rest });
      if (clearHfToken) delete next.hfToken;
      else if (hfToken) next.hfToken = hfToken;
      await this.atomic('settings.json', next);
      this.settings = next;
      return this.publicSettings();
    });
  }
}
