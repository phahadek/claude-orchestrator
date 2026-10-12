import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../config', () => ({ getProjectByGithubRepo: vi.fn() }));
vi.mock('../../db/queries', () => ({ setPauseReason: vi.fn() }));
vi.mock('../../session/orchestrator-config', () => ({
  loadOrchestratorConfig: vi.fn(),
}));
vi.mock('../../routes/tasks', () => ({ emitTaskUpdated: vi.fn() }));

import { getProjectByGithubRepo } from '../../config';
import { setPauseReason } from '../../db/queries';
import { loadOrchestratorConfig } from '../../session/orchestrator-config';
import {
  checkMigrationNumberCollision,
  guardMigrationNumbersBeforeMerge,
} from '../migrationNumberGuard';
import type { PullRequestRow } from '../../db/types';

const DIR = 'migrations/postgres';
const cfg = { dir: DIR, filenamePattern: /^(\d+)_.+\.sql$/ };
const pr = { prNumber: 7, repo: 'o/r', baseBranch: 'dev' };

function makeGithub(
  prFiles: Array<{ filename: string; status: string }>,
  basePaths: string[] | Error,
) {
  return {
    getPRFiles: vi.fn().mockResolvedValue(prFiles),
    listFilePathsAtRef:
      basePaths instanceof Error
        ? vi.fn().mockRejectedValue(basePaths)
        : vi.fn().mockResolvedValue(basePaths),
  };
}

describe('checkMigrationNumberCollision', () => {
  it('flags a PR-added number already on the base branch and reports nextFree', async () => {
    const gh = makeGithub(
      [{ filename: `${DIR}/0255_new.sql`, status: 'added' }],
      [`${DIR}/0254_a.sql`, `${DIR}/0255_other.sql`, 'README.md'],
    );
    const res = await checkMigrationNumberCollision(gh as never, pr, cfg);
    expect(res).toEqual({
      ok: false,
      collisions: [
        {
          prFile: `${DIR}/0255_new.sql`,
          number: 255,
          baseFile: `${DIR}/0255_other.sql`,
        },
      ],
      nextFree: 256,
    });
  });

  it('flags two PR-added files sharing a number', async () => {
    const gh = makeGithub(
      [
        { filename: `${DIR}/0300_a.sql`, status: 'added' },
        { filename: `${DIR}/0300_b.sql`, status: 'added' },
      ],
      [`${DIR}/0254_a.sql`],
    );
    const res = await checkMigrationNumberCollision(gh as never, pr, cfg);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.collisions).toEqual([
        {
          prFile: `${DIR}/0300_b.sql`,
          number: 300,
          baseFile: `${DIR}/0300_a.sql`,
        },
      ]);
      expect(res.nextFree).toBe(255);
    }
  });

  it('is ok for a fresh number', async () => {
    const gh = makeGithub(
      [{ filename: `${DIR}/0256_new.sql`, status: 'added' }],
      [`${DIR}/0255_a.sql`],
    );
    expect(await checkMigrationNumberCollision(gh as never, pr, cfg)).toEqual({
      ok: true,
    });
  });

  it('ignores modified files, files outside the dir, and non-matching names', async () => {
    const gh = makeGithub(
      [
        { filename: `${DIR}/0255_a.sql`, status: 'modified' },
        { filename: `other/0255_b.sql`, status: 'added' },
        { filename: `${DIR}/notes.md`, status: 'added' },
      ],
      [`${DIR}/0255_a.sql`],
    );
    expect(await checkMigrationNumberCollision(gh as never, pr, cfg)).toEqual({
      ok: true,
    });
  });

  it('propagates a base-listing failure', async () => {
    const gh = makeGithub([], new Error('boom'));
    await expect(
      checkMigrationNumberCollision(gh as never, pr, cfg),
    ).rejects.toThrow('boom');
  });
});

describe('guardMigrationNumbersBeforeMerge', () => {
  const row = {
    pr_number: 7,
    repo: 'o/r',
    base_branch: 'dev',
    task_id: 't1',
    session_id: 's1',
  } as unknown as PullRequestRow;
  const colliding = () =>
    makeGithub(
      [{ filename: `${DIR}/0255_new.sql`, status: 'added' }],
      [`${DIR}/0255_other.sql`],
    );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'p',
      projectDir: '/p',
    } as never);
    vi.mocked(loadOrchestratorConfig).mockReturnValue({
      migrations: { dir: DIR, filename_pattern: '^(\\d+)_.+\\.sql$' },
    } as never);
  });

  it('is disabled (no GitHub calls) when the project has no migrations config', async () => {
    vi.mocked(loadOrchestratorConfig).mockReturnValue({} as never);
    const gh = colliding();
    const res = await guardMigrationNumbersBeforeMerge(
      gh as never,
      undefined,
      row,
    );
    expect(res).toEqual({ ok: true });
    expect(gh.getPRFiles).not.toHaveBeenCalled();
    expect(gh.listFilePathsAtRef).not.toHaveBeenCalled();
  });

  it('pauses with migration_number_collision and enqueues feedback to the session', async () => {
    const sessions = { enqueueFeedback: vi.fn().mockResolvedValue(undefined) };
    const res = await guardMigrationNumbersBeforeMerge(
      colliding() as never,
      sessions as never,
      row,
    );
    expect(res.ok).toBe(false);
    expect(setPauseReason).toHaveBeenCalledWith(
      7,
      'o/r',
      'migration_number_collision',
      expect.stringContaining('Next free number on dev: 256'),
    );
    const detail = vi.mocked(setPauseReason).mock.calls[0][3] as string;
    expect(detail).toContain(`${DIR}/0255_new.sql`);
    expect(detail).toContain(`${DIR}/0255_other.sql`);
    expect(sessions.enqueueFeedback).toHaveBeenCalledWith(
      's1',
      'migration-collision',
      expect.stringContaining('Rename to the next free number'),
    );
  });

  it('still sets the pause when there is no linked session', async () => {
    const sessions = { enqueueFeedback: vi.fn() };
    const res = await guardMigrationNumbersBeforeMerge(
      colliding() as never,
      sessions as never,
      { ...row, session_id: null } as PullRequestRow,
    );
    expect(res.ok).toBe(false);
    expect(setPauseReason).toHaveBeenCalled();
    expect(sessions.enqueueFeedback).not.toHaveBeenCalled();
  });

  it('fails closed on a base-listing failure without pausing, and re-checks next time', async () => {
    const failing = makeGithub([], new Error('502'));
    const res = await guardMigrationNumbersBeforeMerge(
      failing as never,
      undefined,
      row,
    );
    expect(res).toMatchObject({ ok: false, kind: 'check_failed' });
    expect(setPauseReason).not.toHaveBeenCalled();

    const healthy = makeGithub(
      [{ filename: `${DIR}/0300_new.sql`, status: 'added' }],
      [`${DIR}/0255_a.sql`],
    );
    expect(
      await guardMigrationNumbersBeforeMerge(healthy as never, undefined, row),
    ).toEqual({ ok: true });
  });
});
