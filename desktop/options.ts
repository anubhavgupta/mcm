import { posix, win32 } from 'node:path';

export function desktopDataDir(platform: string, env: Record<string, string | undefined>, home: string): string {
  const paths = platform === 'win32' ? win32 : posix;
  if (env.MCM_DATA_DIR) {
    if (!paths.isAbsolute(env.MCM_DATA_DIR)) throw new Error('Desktop MCM_DATA_DIR must be an absolute path.');
    return paths.normalize(env.MCM_DATA_DIR);
  }
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || env.APPDATA;
    if (!base || !paths.isAbsolute(base)) throw new Error('Set LOCALAPPDATA, APPDATA, or an absolute MCM_DATA_DIR.');
    return paths.join(base, 'MCM');
  }
  if (platform !== 'linux') throw new Error('MCM desktop supports Windows and Linux.');
  const base = env.XDG_DATA_HOME || paths.join(home, '.local', 'share');
  if (!paths.isAbsolute(base)) throw new Error('XDG_DATA_HOME must be an absolute path.');
  return paths.join(base, 'mcm');
}

export function desktopPorts(env: Record<string, string | undefined>): number[] {
  const configured = env.MCM_PORT ?? '7838';
  const port = Number(configured);
  if (!/^\d+$/.test(configured) || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('MCM_PORT must be an integer from 1024 to 65535.');
  }
  const address = env.DENO_SERVE_ADDRESS;
  if (!address) return [port];
  const match = /^tcp:127\.0\.0\.1:(\d+)$/.exec(address);
  const nativePort = Number(match?.[1]);
  if (!match || !Number.isInteger(nativePort) || nativePort < 1 || nativePort > 65535) {
    throw new Error('Invalid native DENO_SERVE_ADDRESS; expected tcp:127.0.0.1:<port>.');
  }
  return [...new Set([port, nativePort])];
}
