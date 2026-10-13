import { describe, it, expect, vi, beforeEach } from 'vitest';

const q = vi.hoisted(() => ({
  getPRBySessionId: vi.fn(),
  setConflictNudgeSha: vi.fn(),
  setTaskExecuteNow: vi.fn(),
}));
vi.mock('../../db/queries', () => q);
vi.mock('../../audit/AuditLog', () => ({ recordEvent: vi.fn() }));

import { routePreTestMergeConflict } from '../conflictNudge';
import { recordEvent } from '../../audit/AuditLog';

const basePr = {
  pr_number: 7,
  repo: 'o/r',
  session_id: 's1',
  head_sha: 'abc',
  head_branch: 'feature/x',
  base_branch: 'dev',
  task_id: 't1',
  conflict_nudge_sha: null as string | null,
};

function sessions(relaunch: unknown = 's2') {
  return {
    sendOrResume: vi.fn().mockResolvedValue(true),
    relaunchFixerForPR: vi.fn().mockResolvedValue(relaunch),
  };
}

const info = (producer: 'session_request' | 'pr_gate') => ({
  sessionId: 's1',
  taskId: 't1',
  projectId: 'p1',
  baseBranch: 'dev',
  producer,
});

beforeEach(() => {
  vi.clearAllMocks();
  q.getPRBySessionId.mockReturnValue({ ...basePr });
});

describe('routePreTestMergeConflict', () => {
  it('session_request: sets Execute Now and nudges the owning session directly', async () => {
    const sm = sessions();
    await routePreTestMergeConflict(sm as never, info('session_request'));
    expect(q.setTaskExecuteNow).toHaveBeenCalledWith(
      't1',
      'p1',
      'merge_conflict',
    );
    expect(sm.sendOrResume).toHaveBeenCalledWith('s1', expect.any(String));
    expect(sm.relaunchFixerForPR).not.toHaveBeenCalled();
    expect(q.setConflictNudgeSha).toHaveBeenCalledWith(7, 'o/r', 'abc');
  });

  it('session_request with no PR still nudges the session', async () => {
    q.getPRBySessionId.mockReturnValue(null);
    const sm = sessions();
    await routePreTestMergeConflict(sm as never, info('session_request'));
    expect(sm.sendOrResume).toHaveBeenCalledTimes(1);
  });

  it.each(['idle', 'terminal', 'idle-no-worktree'])(
    'pr_gate (%s session): routes through relaunchFixerForPR',
    async (state) => {
      const sm = sessions(state === 'idle-no-worktree' ? null : 's2');
      await routePreTestMergeConflict(sm as never, info('pr_gate'));
      expect(q.setTaskExecuteNow).toHaveBeenCalled();
      expect(sm.relaunchFixerForPR).toHaveBeenCalledTimes(1);
      expect(sm.sendOrResume).not.toHaveBeenCalled();
      if (state === 'idle-no-worktree') {
        expect(q.setConflictNudgeSha).not.toHaveBeenCalled();
      } else {
        expect(q.setConflictNudgeSha).toHaveBeenCalledWith(7, 'o/r', 'abc');
        expect(recordEvent).toHaveBeenCalledWith(
          expect.objectContaining({ event_type: 'conflict_nudge_sent' }),
        );
      }
    },
  );

  it.each(['session_request', 'pr_gate'] as const)(
    '%s: a head_sha already nudged is not re-nudged',
    async (producer) => {
      q.getPRBySessionId.mockReturnValue({
        ...basePr,
        conflict_nudge_sha: 'abc',
      });
      const sm = sessions();
      await routePreTestMergeConflict(sm as never, info(producer));
      expect(q.setTaskExecuteNow).toHaveBeenCalled();
      expect(sm.sendOrResume).not.toHaveBeenCalled();
      expect(sm.relaunchFixerForPR).not.toHaveBeenCalled();
    },
  );
});
