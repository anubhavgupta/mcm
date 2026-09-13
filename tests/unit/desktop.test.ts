import { describe, expect, it } from 'vitest';
import { desktopDataDir, desktopPorts } from '../../desktop/options';

describe('native desktop settings', () => {
  it('uses stable OS application data paths, not the launch directory', () => {
    expect(desktopDataDir('linux', {}, '/home/user')).toBe('/home/user/.local/share/mcm');
    expect(desktopDataDir('linux', { XDG_DATA_HOME: '/data' }, '/home/user')).toBe('/data/mcm');
    expect(desktopDataDir('win32', { LOCALAPPDATA: 'C:\\Users\\User\\AppData\\Local', APPDATA: 'D:\\Roaming' }, '')).toBe('C:\\Users\\User\\AppData\\Local\\MCM');
    expect(desktopDataDir('win32', { APPDATA: 'D:\\Roaming' }, '')).toBe('D:\\Roaming\\MCM');
    expect(desktopDataDir('win32', { MCM_DATA_DIR: 'D:\\My MCM' }, '')).toBe('D:\\My MCM');
    expect(desktopDataDir('linux', { MCM_DATA_DIR: '/my/mcm' }, '')).toBe('/my/mcm');
    for (const env of [{ MCM_DATA_DIR: '.mcm' }, { XDG_DATA_HOME: 'relative' }]) {
      expect(() => desktopDataDir('linux', env, '/home/user')).toThrow('absolute');
    }
    expect(() => desktopDataDir('win32', {}, '')).toThrow('LOCALAPPDATA');
  });
  it('keeps the conventional API port and validates the private native listener', () => {
    expect(desktopPorts({})).toEqual([7838]);
    expect(desktopPorts({ DENO_SERVE_ADDRESS: 'tcp:127.0.0.1:45678' })).toEqual([7838, 45678]);
    expect(desktopPorts({ DENO_SERVE_ADDRESS: 'tcp:127.0.0.1:7838' })).toEqual([7838]);
    expect(desktopPorts({ MCM_PORT: '9000' })).toEqual([9000]);
    for (const MCM_PORT of ['', '0', '1023', '65536', 'NaN', '1.5', '1e4', ' 7838']) {
      expect(() => desktopPorts({ MCM_PORT })).toThrow('MCM_PORT');
    }
    for (const DENO_SERVE_ADDRESS of ['tcp:0.0.0.0:8000', 'tcp:127.0.0.1:0', 'tcp:127.0.0.1:65536', 'http://127.0.0.1:8080']) {
      expect(() => desktopPorts({ DENO_SERVE_ADDRESS })).toThrow('DENO_SERVE_ADDRESS');
    }
  });
});
