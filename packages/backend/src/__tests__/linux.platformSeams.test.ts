import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';

import { resolveClaudePath } from '../config.js';
import { claudeCredentialsPath } from '../config/credentialsPath.js';
import {
  normalizePath,
  detectInFlightEscape,
} from '../session/SessionAuditor.js';

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

// ── detectInFlightEscape — Linux path separators (Linux-only) ─────────────────

describe.skipIf(process.platform !== 'linux')(
  'detectInFlightEscape — Linux path separators',
  () => {
    const WORKTREE = '/home/user/projects/.claude/worktrees/abc123';

    it('path inside worktree is not an escape', () => {
      const result = detectInFlightEscape(
        'Write',
        { file_path: `${WORKTREE}/src/index.ts`, content: '' },
        WORKTREE,
      );
      expect(result).toBeNull();
    });

    it('path outside worktree is detected as an escape', () => {
      const result = detectInFlightEscape(
        'Write',
        { file_path: '/tmp/malicious.sh', content: '' },
        WORKTREE,
      );
      expect(result).not.toBeNull();
      expect(result?.type).toBe('worktree_escape');
    });

    it('/c/... path outside worktree is not mistakenly converted to C:\\ and is detected as escape', () => {
      const result = detectInFlightEscape(
        'Write',
        { file_path: '/c/tmp/file.ts', content: '' },
        WORKTREE,
      );
      expect(result).not.toBeNull();
      // escapedTo should be a Linux-style path, not a Windows C:\ path
      expect(result?.escapedTo).not.toMatch(/^C:/i);
    });

    it('Bash redirect outside worktree is detected', () => {
      const result = detectInFlightEscape(
        'Bash',
        { command: 'echo hello > /etc/hosts' },
        WORKTREE,
      );
      expect(result).not.toBeNull();
    });
  },
);
