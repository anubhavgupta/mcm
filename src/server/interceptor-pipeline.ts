import { chmod, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { CustomInterceptorEntry, InterceptorPipeline } from '../shared/types';
import type { Interceptor } from './interceptors';
import { atomicJson } from './storage';
import { ApiError } from './errors';

const modulePathSchema = z.string().min(1).max(4096).refine(
  value => isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value),
  'Use an absolute trusted local module path.',
);
const entrySchema = z.object({
  id: z.string().regex(/^custom-[a-zA-Z0-9_-]{1,93}$/, 'Custom IDs must start with custom-. Locked entries cannot be changed.'),
  name: z.string().trim().min(1).max(100).refine(value => !/[\x00-\x1f\x7f]/.test(value), 'Invalid name.'),
  modulePath: modulePathSchema,
}).strict();
const entriesSchema = z.array(entrySchema).max(32).refine(
  entries => new Set(entries.map(entry => entry.id)).size === entries.length, 'Interceptor IDs must be unique.',
).refine(
  entries => new Set(entries.map(entry => entry.modulePath)).size === entries.length, 'Module paths must be unique.',
);
const persistedSchema = z.object({ entries: entriesSchema }).strict();
export const interceptorUpdateSchema = persistedSchema.extend({ trustedCodeAcknowledged: z.literal(true) }).strict();
const hooks = ['beforeRequest', 'onRequest', 'onOutboundRequest', 'onRequestChunk', 'onRequestEnd',
  'onResponse', 'onResponseChunk', 'onComplete', 'onError'] as const;

/** Imports trusted local code, never workspace content or remote URLs. Node caches modules until restart. */
export async function loadInterceptorModule(modulePath: string): Promise<Interceptor[]> {
  modulePathSchema.parse(modulePath);
  try {
    if (!(await stat(modulePath)).isFile()) throw new Error('Not a file.');
    const module = await import(/* @vite-ignore */ pathToFileURL(modulePath).href) as {
      default?: unknown; interceptors?: unknown;
    };
    const exported = module.interceptors ?? module.default;
    const values: unknown[] = Array.isArray(exported) ? exported : [exported];
    if (!values.length || values.length > 64 || values.some(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
      const interceptor = value as Interceptor;
      return !hooks.some(key => typeof interceptor[key] === 'function') ||
        hooks.some(key => interceptor[key] !== undefined && typeof interceptor[key] !== 'function');
    })) throw new Error('Invalid interceptor export.');
    return values as Interceptor[];
  } catch {
    throw new ApiError(400, 'Cannot load interceptor module. Check that the trusted local file exists and exports one or more Interceptor objects with valid hooks. Restart MCM after editing module files.');
  }
}

export class InterceptorRegistry {
  private entries: CustomInterceptorEntry[] = [];
  private pipeline: readonly Interceptor[];
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  constructor(
    private directory: string,
    private required: readonly [Interceptor, Interceptor],
    private environment: readonly Interceptor[] = [],
    private write: typeof atomicJson = atomicJson,
  ) {
    this.pipeline = [...required, ...environment];
  }
  async init(): Promise<void> {
    const path = join(this.directory, 'interceptors.json');
    let input: unknown;
    try {
      await chmod(path, 0o600);
      input = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('Cannot load interceptors.json: invalid or unreadable persisted data.', { cause: error });
      }
      input = { entries: [] };
      await this.write(this.directory, 'interceptors.json', input);
    }
    const { entries } = persistedSchema.parse(input);
    const custom = await this.load(entries);
    this.entries = entries;
    this.pipeline = [...this.required, ...this.environment, ...custom];
  }
  private async load(entries: CustomInterceptorEntry[]): Promise<Interceptor[]> {
    const custom: Interceptor[] = [];
    for (const entry of entries) custom.push(...await loadInterceptorModule(entry.modulePath));
    return custom;
  }
  snapshot(): readonly Interceptor[] { return [...this.pipeline]; }
  get(): InterceptorPipeline {
    return { entries: [
      { id: 'builtin-telemetry', name: 'Token and cost telemetry', source: 'builtin', locked: true },
      ...(this.environment.length ? [{
        id: 'environment-interceptors', name: 'Environment-configured interceptors', source: 'environment' as const, locked: true as const,
      }] : []),
      ...this.entries.map(entry => ({ ...entry, source: 'local' as const, locked: false as const })),
    ] };
  }
  async update(input: unknown): Promise<InterceptorPipeline> {
    const { entries } = interceptorUpdateSchema.parse(input);
    if (this.closing) throw new ApiError(503, 'Manager is shutting down.');
    const operation = this.queue.then(async () => {
      const custom = await this.load(entries);
      // Keep the live chain unchanged until every module and the durable write have succeeded.
      await this.write(this.directory, 'interceptors.json', { entries });
      this.entries = entries;
      this.pipeline = [...this.required, ...this.environment, ...custom];
      return this.get();
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  async close(): Promise<void> {
    this.closing = true;
    await this.queue;
  }
}
