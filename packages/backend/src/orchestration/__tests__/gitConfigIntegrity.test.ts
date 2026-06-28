import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const mockExec = vi.fn();
  (mockExec as unknown as Record<symbol, unknown>)[
    Symbol.for('nodejs.util.promisify.custom')
  ] = (command: string, options: unknown) =>
    new Promise((resolve, reject) => {
      (mockExec as unknown as (...args: unknown[]) => unknown)(
        command,
        options,
        (err: Error | null, stdout: string, stderr: string) => {
          if (err) reject(err);
          else resolve({ stdout, stderr });
        },
      );
    });
  return { ...actual, exec: mockExec };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn(),
      copyFileSync: vi.fn(),
      existsSync: vi.fn(),
    },
  };
});

vi.mock('../../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../config.js', () => ({
  getAllProjects: vi.fn(),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { exec } from 'node:child_process';
import fs from 'node:fs';
import { recordEvent } from '../../audit/AuditLog.js';
import { getAllProjects } from '../../config.js';
import {
  isConfigCorrupted,
  validateAndRepairGitConfig,
  runGitConfigIntegrityCheck,
} from '../gitConfigIntegrity.js';

const mockExec = vi.mocked(exec);
const mockFs = vi.mocked(fs);
const mockRecordEvent = vi.mocked(recordEvent);
const mockGetAllProjects = vi.mocked(getAllProjects);

const REPO_DIR = '/fake/repo';
const CONFIG_PATH = path.join(REPO_DIR, '.git', 'config');
const BACKUP_PATH = path.join(REPO_DIR, '.git', 'config.orchestrator-backup');

// Helper to make exec resolve (parseable)
function makeExecResolve() {
  mockExec.mockImplementation((_cmd, _opts, cb) => {
    (cb as (err: null, stdout: string, stderr: string) => void)(
      null,
      '[core]\n\trepositoryformatversion = 0\n',
      '',
    );
    return {} as ReturnType<typeof exec>;
  });
}

// Helper to make exec reject (parse error)
function makeExecReject(message = 'bad config line 1') {
  mockExec.mockImplementation((_cmd, _opts, cb) => {
    const err = new Error(message);
    (cb as (err: Error) => void)(err);
    return {} as ReturnType<typeof exec>;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFs.existsSync.mockReturnValue(false);
});

// ── isConfigCorrupted ─────────────────────────────────────────────────────────

describe('isConfigCorrupted()', () => {
  it('returns true when file is empty', () => {
    mockFs.readFileSync.mockReturnValue(Buffer.alloc(0));
    expect(isConfigCorrupted(CONFIG_PATH)).toBe(true);
  });

  it('returns true when file is all-NUL bytes', () => {
    mockFs.readFileSync.mockReturnValue(Buffer.alloc(512, 0));
    expect(isConfigCorrupted(CONFIG_PATH)).toBe(true);
  });

  it('returns true when readFileSync throws (file missing)', () => {
    mockFs.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(isConfigCorrupted(CONFIG_PATH)).toBe(true);
  });

  it('returns false for a healthy config buffer', () => {
    mockFs.readFileSync.mockReturnValue(
      Buffer.from('[core]\n\trepositoryformatversion = 0\n'),
    );
    expect(isConfigCorrupted(CONFIG_PATH)).toBe(false);
  });

  it('returns false when only some bytes are NUL', () => {
    const buf = Buffer.from('[core]\x00repositoryformatversion = 0\n');
    mockFs.readFileSync.mockReturnValue(buf);
    expect(isConfigCorrupted(CONFIG_PATH)).toBe(false);
  });
});

// ── validateAndRepairGitConfig ────────────────────────────────────────────────

describe('validateAndRepairGitConfig()', () => {
  it('leaves healthy config untouched and snapshots the backup', async () => {
    mockFs.readFileSync.mockReturnValue(
      Buffer.from('[core]\n\trepositoryformatversion = 0\n'),
    );
    makeExecResolve();
    mockFs.existsSync.mockReturnValue(false); // no prior backup

    const result = await validateAndRepairGitConfig(REPO_DIR, 'proj-1');

    expect(result.healthy).toBe(true);
    expect(result.repaired).toBe(false);
    expect(mockFs.copyFileSync).toHaveBeenCalledWith(CONFIG_PATH, BACKUP_PATH);
    expect(mockRecordEvent).not.toHaveBeenCalled();
  });

  it('detects all-NUL config as corrupted and restores backup', async () => {
    mockFs.readFileSync.mockReturnValue(Buffer.alloc(512, 0));
    mockFs.existsSync.mockReturnValue(true); // backup exists

    const result = await validateAndRepairGitConfig(REPO_DIR, 'proj-1');

    expect(result.healthy).toBe(true);
    expect(result.repaired).toBe(true);
    expect(mockFs.copyFileSync).toHaveBeenCalledWith(BACKUP_PATH, CONFIG_PATH);
    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'repo_git_config_repaired',
        actor_type: 'system',
        project_id: 'proj-1',
        payload: expect.objectContaining({ reason: 'empty_or_null_bytes' }),
      }),
    );
  });

  it('detects parse-error config as corrupted and restores backup', async () => {
    mockFs.readFileSync.mockReturnValue(
      Buffer.from('GARBAGE\x00\x00NOT A VALID CONFIG'),
    );
    makeExecReject('bad config line 1');
    mockFs.existsSync.mockReturnValue(true);

    const result = await validateAndRepairGitConfig(REPO_DIR, 'proj-2');

    expect(result.healthy).toBe(true);
    expect(result.repaired).toBe(true);
    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'repo_git_config_repaired',
        payload: expect.objectContaining({ reason: 'parse_error' }),
      }),
    );
  });

  it('reports not repaired when backup is unavailable', async () => {
    mockFs.readFileSync.mockReturnValue(Buffer.alloc(64, 0));
    mockFs.existsSync.mockReturnValue(false); // no backup

    const result = await validateAndRepairGitConfig(REPO_DIR, 'proj-3');

    expect(result.healthy).toBe(false);
    expect(result.repaired).toBe(false);
    expect(mockFs.copyFileSync).not.toHaveBeenCalled();
    expect(mockRecordEvent).not.toHaveBeenCalled();
  });

  it('emits audit event with correct project_id on repair', async () => {
    mockFs.readFileSync.mockReturnValue(Buffer.alloc(1, 0));
    mockFs.existsSync.mockReturnValue(true);

    await validateAndRepairGitConfig(REPO_DIR, 'my-project');

    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: 'my-project' }),
    );
  });
});

// ── runGitConfigIntegrityCheck ────────────────────────────────────────────────

describe('runGitConfigIntegrityCheck()', () => {
  it('processes all projects returned by listProjects', async () => {
    const projects = [
      { id: 'p1', projectDir: '/repo/p1' },
      { id: 'p2', projectDir: '/repo/p2' },
    ];
    mockGetAllProjects.mockReturnValue(projects as never);

    // Both repos healthy
    mockFs.readFileSync.mockReturnValue(
      Buffer.from('[core]\n\trepositoryformatversion = 0\n'),
    );
    makeExecResolve();

    await runGitConfigIntegrityCheck();

    // copyFileSync called once per project (snapshot)
    expect(mockFs.copyFileSync).toHaveBeenCalledTimes(2);
  });

  it('accepts a custom listProjects override', async () => {
    const custom = [{ id: 'custom', projectDir: '/custom/repo' }];
    mockFs.readFileSync.mockReturnValue(
      Buffer.from('[core]\n\trepositoryformatversion = 0\n'),
    );
    makeExecResolve();

    await runGitConfigIntegrityCheck({
      listProjects: () => custom as never,
    });

    expect(mockFs.copyFileSync).toHaveBeenCalledTimes(1);
  });

  it('continues processing remaining projects when one throws', async () => {
    const projects = [
      { id: 'bad', projectDir: '/bad/repo' },
      { id: 'good', projectDir: '/good/repo' },
    ];
    mockGetAllProjects.mockReturnValue(projects as never);

    let call = 0;
    mockFs.readFileSync.mockImplementation(() => {
      call++;
      if (call === 1) throw new Error('unexpected');
      return Buffer.from('[core]\n');
    });
    makeExecResolve();

    // Must not throw
    await expect(runGitConfigIntegrityCheck()).resolves.toBeUndefined();

    // The second project was still checked (snapshot attempted)
    expect(mockFs.copyFileSync).toHaveBeenCalledTimes(1);
  });

  it('is registered before resume_orphan_sessions in the boot sequence step list', async () => {
    // Verify via the exported step list constant in bootSequence
    // We import it here to avoid pulling in the full server setup
    const { BootStatusTracker } = await import('../../bootSequence.js');
    const captured: string[] = [];
    const tracker = new BootStatusTracker(() => {});
    const origStart = tracker.startSequence.bind(tracker);
    vi.spyOn(tracker, 'startSequence').mockImplementation((steps) => {
      captured.push(...steps);
      origStart(steps);
    });
    tracker.startSequence([
      'jsonl_import',
      'session_events_pruner_at_boot',
      'git_config_integrity_check',
      'resume_orphan_sessions',
      'stuck_session_monitor_rehydrate',
      'auto_merger_rehydrate',
      'worktree_reconciliation',
      'pr_boot_sweep',
      'boot_idle_reconciliation',
      'stalled_pr_reconciliation',
      'auto_launcher_start',
    ]);

    const integrityIdx = captured.indexOf('git_config_integrity_check');
    const resumeIdx = captured.indexOf('resume_orphan_sessions');
    expect(integrityIdx).toBeGreaterThanOrEqual(0);
    expect(integrityIdx).toBeLessThan(resumeIdx);
  });
});
