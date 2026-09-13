import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicJson } from '../src/server/storage';

export const inferenceGeometrySchema = z.strictObject({
  width: z.number().int().min(1).max(32768),
  height: z.number().int().min(1).max(32768),
  x: z.number().int().min(-1_000_000).max(1_000_000),
  y: z.number().int().min(-1_000_000).max(1_000_000),
});
export type InferenceGeometry = z.infer<typeof inferenceGeometrySchema>;
export interface GeometryPersistence {
  load(): Promise<InferenceGeometry | undefined>;
  save(geometry: InferenceGeometry): Promise<void>;
}
export class InferenceGeometryStore implements GeometryPersistence {
  private pending: Promise<void> = Promise.resolve();
  constructor(private directory: string) {}
  async load(): Promise<InferenceGeometry | undefined> {
    try {
      return inferenceGeometrySchema.parse(JSON.parse(await readFile(join(this.directory, 'inference-window.json'), 'utf8')));
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
      throw new Error('Cannot read inference-window.json. Check its contents and data-directory permissions.', { cause: error });
    }
  }
  save(geometry: InferenceGeometry): Promise<void> {
    const validated = inferenceGeometrySchema.parse(geometry);
    const operation = this.pending.then(() => atomicJson(this.directory, 'inference-window.json', validated));
    this.pending = operation.catch(() => {});
    return operation;
  }
}
