import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InferenceGeometryStore } from '../../desktop/inference-geometry';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'mcm-inference-geometry-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('machine-local native inference geometry', () => {
  it('starts without saved bounds and restores them from a new store instance', async () => {
    const store = new InferenceGeometryStore(directory);
    expect(await store.load()).toBeUndefined();
    const geometry = { width: 450, height: 700, x: -500, y: 250 };
    await store.save(geometry);
    expect(await new InferenceGeometryStore(directory).load()).toEqual(geometry);
    expect(JSON.parse(await readFile(join(directory, 'inference-window.json'), 'utf8'))).toEqual(geometry);
    if (process.platform !== 'win32') expect((await stat(join(directory, 'inference-window.json'))).mode & 0o777).toBe(0o600);
  });
  it('serializes updates so the final user position wins', async () => {
    const store = new InferenceGeometryStore(directory);
    await Promise.all([1, 2, 3].map(x => store.save({ width: 400, height: 600, x, y: 100 })));
    expect(await store.load()).toMatchObject({ x: 3 });
  });
  it('rejects damaged or invalid saved bounds explicitly', async () => {
    await writeFile(join(directory, 'inference-window.json'), '{broken');
    await expect(new InferenceGeometryStore(directory).load()).rejects.toThrow('Cannot read inference-window.json');
    await writeFile(join(directory, 'inference-window.json'), '{"width":0,"height":20,"x":0,"y":0}');
    await expect(new InferenceGeometryStore(directory).load()).rejects.toThrow('Cannot read inference-window.json');
  });
});
