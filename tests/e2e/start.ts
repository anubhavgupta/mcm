import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = await mkdtemp(path.join(tmpdir(), 'mcm-e2e-'));
const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
  cwd: process.cwd(),
  stdio: 'inherit',
  env: { ...process.env, MCM_PORT: '17838', MCM_DATA_DIR: dataDir },
});
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
child.on('error', error => {
  console.error(error);
  process.exitCode = 1;
});
child.on('close', async code => {
  await rm(dataDir, { recursive: true, force: true });
  process.exitCode = code ?? 0;
});
