import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import { getDataDir } from '../config/dataDir.js';

describe('getDataDir', () => {
  const originalAppData = process.env.APPDATA;
  const originalXdgDataHome = process.env.XDG_DATA_HOME;

  beforeEach(() => {
    delete process.env.APPDATA;
    delete process.env.XDG_DATA_HOME;
  });

  afterEach(() => {
    if (originalAppData !== undefined) process.env.APPDATA = originalAppData;
    else delete process.env.APPDATA;
    if (originalXdgDataHome !== undefined)
      process.env.XDG_DATA_HOME = originalXdgDataHome;
    else delete process.env.XDG_DATA_HOME;
  });

  it('win32: uses APPDATA env var when set', () => {
    process.env.APPDATA = 'C:\\Users\\test\\AppData\\Roaming';
    const dir = getDataDir('win32');
    expect(dir).toBe(
      path.join('C:\\Users\\test\\AppData\\Roaming', 'ClaudeOrchestrator'),
    );
  });

  it('win32: falls back to homedir when APPDATA is unset', () => {
    const dir = getDataDir('win32');
    expect(dir).toBe(path.join(os.homedir(), 'ClaudeOrchestrator'));
  });

  it('darwin: always uses Library/Application Support', () => {
    const dir = getDataDir('darwin');
    expect(dir).toBe(
      path.join(
        os.homedir(),
        'Library',
        'Application Support',
        'ClaudeOrchestrator',
      ),
    );
  });

  it('linux: uses XDG_DATA_HOME when set', () => {
    process.env.XDG_DATA_HOME = '/custom/data';
    const dir = getDataDir('linux');
    expect(dir).toBe(path.join('/custom/data', 'claude-orchestrator'));
  });

  it('linux: falls back to ~/.local/share when XDG_DATA_HOME unset', () => {
    const dir = getDataDir('linux');
    expect(dir).toBe(
      path.join(os.homedir(), '.local', 'share', 'claude-orchestrator'),
    );
  });

  it('unknown platform: treated as linux', () => {
    const dir = getDataDir('freebsd' as NodeJS.Platform);
    expect(dir).toBe(
      path.join(os.homedir(), '.local', 'share', 'claude-orchestrator'),
    );
  });
});
