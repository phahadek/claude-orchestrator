import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';

import { getDataDir } from '../config/dataDir.js';
import { resolveClaudePath } from '../config.js';
import { claudeCredentialsPath } from '../config/credentialsPath.js';
import {
  normalizePath,
  detectInFlightEscape,
} from '../session/SessionAuditor.js';
import { getChildRssMb } from '../session/test-runner.js';

// ── getDataDir — Linux / XDG ───────────────────────────────────────────────────

describe('getDataDir — linux platform injection', () => {
  const originalXdg = process.env.XDG_DATA_HOME;

  beforeEach(() => {
    delete process.env.XDG_DATA_HOME;
  });

  afterEach(() => {
    if (originalXdg !== undefined) process.env.XDG_DATA_HOME = originalXdg;
    else delete process.env.XDG_DATA_HOME;
  });

  it('returns ${XDG_DATA_HOME}/claude-orchestrator when XDG_DATA_HOME is set', () => {
    process.env.XDG_DATA_HOME = '/custom/xdg';
    expect(getDataDir('linux')).toBe(path.join('/custom/xdg', 'claude-orchestrator'));
  });

  it('returns ~/.local/share/claude-orchestrator when XDG_DATA_HOME is unset', () => {
    expect(getDataDir('linux')).toBe(
      path.join(os.homedir(), '.local', 'share', 'claude-orchestrator'),
    );
  });
});

// ── resolveClaudePath ──────────────────────────────────────────────────────────

describe('resolveClaudePath — platform injection', () => {
  const originalClaudePath = process.env.CLAUDE_PATH;

  beforeEach(() => {
    delete process.env.CLAUDE_PATH;
  });

  afterEach(() => {
    if (originalClaudePath !== undefined) {
      process.env.CLAUDE_PATH = originalClaudePath;
    } else {
      delete process.env.CLAUDE_PATH;
    }
  });

  it('uses "which claude" on linux', () => {
    const mockExec = vi.fn().mockReturnValue('/usr/bin/claude\n');
    const result = resolveClaudePath('linux', mockExec);
    expect(mockExec).toHaveBeenCalledWith('which claude', { encoding: 'utf8' });
    expect(result).toBe('/usr/bin/claude');
  });

  it('uses "which claude" on darwin', () => {
    const mockExec = vi.fn().mockReturnValue('/usr/local/bin/claude\n');
    const result = resolveClaudePath('darwin', mockExec);
    expect(mockExec).toHaveBeenCalledWith('which claude', { encoding: 'utf8' });
    expect(result).toBe('/usr/local/bin/claude');
  });

  it('uses "where claude" on win32', () => {
    const mockExec = vi.fn().mockReturnValue('C:\\Windows\\claude.cmd\r\n');
    const result = resolveClaudePath('win32', mockExec);
    expect(mockExec).toHaveBeenCalledWith('where claude', { encoding: 'utf8' });
    expect(result).toBe('C:\\Windows\\claude.cmd');
  });

  it('returns CLAUDE_PATH env var immediately when set, without calling exec', () => {
    process.env.CLAUDE_PATH = '/custom/path/claude';
    const mockExec = vi.fn();
    const result = resolveClaudePath('linux', mockExec);
    expect(mockExec).not.toHaveBeenCalled();
    expect(result).toBe('/custom/path/claude');
  });

  it('falls back to "claude" when exec throws', () => {
    const mockExec = vi.fn().mockImplementation(() => {
      throw new Error('command not found');
    });
    const result = resolveClaudePath('linux', mockExec);
    expect(result).toBe('claude');
  });

  it('returns first line only when exec returns multiple lines', () => {
    const mockExec = vi
      .fn()
      .mockReturnValue('/usr/bin/claude\n/usr/local/bin/claude\n');
    const result = resolveClaudePath('linux', mockExec);
    expect(result).toBe('/usr/bin/claude');
  });
});

// ── claudeCredentialsPath ──────────────────────────────────────────────────────

describe('claudeCredentialsPath — platform injection', () => {
  const originalAppData = process.env.APPDATA;

  beforeEach(() => {
    delete process.env.APPDATA;
  });

  afterEach(() => {
    if (originalAppData !== undefined) {
      process.env.APPDATA = originalAppData;
    } else {
      delete process.env.APPDATA;
    }
  });

  it('returns ~/.claude/.credentials.json on linux', () => {
    const result = claudeCredentialsPath('linux');
    expect(result).toBe(
      path.join(os.homedir(), '.claude', '.credentials.json'),
    );
  });

  it('returns ~/.claude/.credentials.json on darwin', () => {
    const result = claudeCredentialsPath('darwin');
    expect(result).toBe(
      path.join(os.homedir(), '.claude', '.credentials.json'),
    );
  });

  it('returns %APPDATA%\\Claude\\.credentials.json on win32 when APPDATA is set', () => {
    process.env.APPDATA = 'C:\\Users\\test\\AppData\\Roaming';
    const result = claudeCredentialsPath('win32');
    expect(result).toBe(
      path.join(
        'C:\\Users\\test\\AppData\\Roaming',
        'Claude',
        '.credentials.json',
      ),
    );
  });

  it('falls back to homedir on win32 when APPDATA is unset', () => {
    const result = claudeCredentialsPath('win32');
    expect(result).toBe(path.join(os.homedir(), 'Claude', '.credentials.json'));
  });
});

// ── normalizePath — Git-Bash conversion guard ──────────────────────────────────

describe('normalizePath — platform injection', () => {
  it('does NOT convert /c/... to C:\\ on linux', () => {
    const result = normalizePath('/c/tmp/file.ts', undefined, 'linux');
    expect(result).not.toMatch(/^[Cc]:/);
  });

  it('does NOT convert /c/... to C:\\ on darwin', () => {
    const result = normalizePath('/c/tmp/file.ts', undefined, 'darwin');
    expect(result).not.toMatch(/^[Cc]:/);
  });

  it('converts /c/... to C:\\ on win32', () => {
    const result = normalizePath('/c/Users/test/file.ts', undefined, 'win32');
    expect(result).toMatch(/^C:/i);
  });

  it('converts /Z/... to Z:\\ on win32 (case-insensitive)', () => {
    const result = normalizePath('/Z/projects/file.ts', undefined, 'win32');
    expect(result).toMatch(/^Z:/i);
  });

  it('leaves regular absolute paths unchanged on linux (no Git-Bash conversion)', () => {
    const result = normalizePath(
      '/home/user/worktrees/abc/file.ts',
      undefined,
      'linux',
    );
    expect(result).not.toMatch(/^[A-Z]:\\/);
  });
});

// ── getChildRssMb — /proc RSS bounding ────────────────────────────────────────

describe('getChildRssMb — platform injection', () => {
  it('returns 0 on non-linux platforms', () => {
    expect(getChildRssMb(12345, 'win32')).toBe(0);
    expect(getChildRssMb(12345, 'darwin')).toBe(0);
  });

  it('parses VmRSS from /proc/<pid>/status on linux', () => {
    const mockRead = vi
      .fn()
      .mockReturnValue('Name: claude\nVmRSS:   51200 kB\nSomethingElse: 0\n');
    const result = getChildRssMb(99, 'linux', mockRead);
    expect(mockRead).toHaveBeenCalledWith('/proc/99/status');
    expect(result).toBe(50); // 51200 kB / 1024 = 50 MB
  });

  it('returns 0 when VmRSS line is absent', () => {
    const mockRead = vi.fn().mockReturnValue('Name: claude\nVmPeak: 1024 kB\n');
    expect(getChildRssMb(99, 'linux', mockRead)).toBe(0);
  });

  it('returns 0 when /proc/<pid>/status cannot be read (process exited)', () => {
    const mockRead = vi.fn().mockImplementation(() => {
      throw new Error('ENOENT: no such file');
    });
    expect(getChildRssMb(99, 'linux', mockRead)).toBe(0);
  });
});

// ── detectInFlightEscape — Linux path separators (cross-platform) ──────────────
//
// Pass `platform: 'linux'` so normalizePath uses path.posix internally,
// making these tests verifiable on Windows without the physical Ubuntu box.

describe('detectInFlightEscape — Linux path separators', () => {
  const WORKTREE = '/home/user/projects/.claude/worktrees/abc123';

  it('path inside worktree is not an escape', () => {
    const result = detectInFlightEscape(
      'Write',
      { file_path: `${WORKTREE}/src/index.ts`, content: '' },
      WORKTREE,
      'linux',
    );
    expect(result).toBeNull();
  });

  it('path outside worktree is detected as an escape', () => {
    const result = detectInFlightEscape(
      'Write',
      { file_path: '/tmp/malicious.sh', content: '' },
      WORKTREE,
      'linux',
    );
    expect(result).not.toBeNull();
    expect(result?.type).toBe('worktree_escape');
  });

  it('/c/... path is not mangled to C:\\ on linux and is detected as escape', () => {
    const result = detectInFlightEscape(
      'Write',
      { file_path: '/c/tmp/file.ts', content: '' },
      WORKTREE,
      'linux',
    );
    expect(result).not.toBeNull();
    expect(result?.escapedTo).not.toMatch(/^C:/i);
  });

  it('Bash redirect outside worktree is detected', () => {
    const result = detectInFlightEscape(
      'Bash',
      { command: 'echo hello > /etc/hosts' },
      WORKTREE,
      'linux',
    );
    expect(result).not.toBeNull();
  });

  it('path equal to worktree root itself is not an escape', () => {
    const result = detectInFlightEscape(
      'Write',
      { file_path: WORKTREE, content: '' },
      WORKTREE,
      'linux',
    );
    expect(result).toBeNull();
  });
});
