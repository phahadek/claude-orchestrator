import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import {
  insertProject,
  insertMilestone,
  updateProject,
  recordProjectDeployedSha,
  insertSession,
  insertDeployRun,
} from '../../db/queries.js';
import {
  buildInvestigateDbSnapshot,
  UnknownInvestigateProjectError,
} from '../investigateSnapshot';

const PID = 'inv-snap-project';

describe('buildInvestigateDbSnapshot', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM audit_log').run();
    db.prepare('DELETE FROM deploy_run').run();
    db.prepare('DELETE FROM pull_requests').run();
    db.prepare('DELETE FROM project_deployed_sha').run();
    db.prepare('DELETE FROM milestones').run();
    db.prepare('DELETE FROM projects').run();
    insertProject({
      id: PID,
      name: 'Inv Snap',
      project_dir: '/nonexistent/inv-snap',
      context_url: null,
      github_repo: null,
      task_source: 'notion',
    });
  });

  it('throws for an unknown project', () => {
    expect(() => buildInvestigateDbSnapshot('nope')).toThrow(
      UnknownInvestigateProjectError,
    );
  });

  it('returns every DB-derived field with the loader values for a seeded DB', () => {
    insertMilestone({
      id: 'm1',
      project_id: PID,
      name: 'Milestone One',
      source_id: 'board-1',
      canonical_short_id: 'M1',
    });
    updateProject(PID, { auto_launch_milestone_id: 'm1' });
    recordProjectDeployedSha(PID, 'abcdef0123456789');
    const now = Date.now();
    insertSession({
      session_id: 's-err',
      task_id: 'notion:t1',
      task_url: null,
      project_context_url: null,
      project_id: PID,
      status: 'error',
      started_at: now - 1000,
      task_name: 'Broken task',
    } as never);
    db.prepare(
      `UPDATE sessions SET last_error_detail = ? WHERE session_id = 's-err'`,
    ).run('failed to assemble planning procedure');
    insertSession({
      session_id: 's-groom',
      task_id: 'notion:t2',
      task_url: null,
      project_context_url: null,
      project_id: PID,
      status: 'idle',
      started_at: now - 2000,
      session_type: 'groom',
      task_name: 'Groomed',
    } as never);
    insertDeployRun({
      run_id: 'r1',
      project: PID,
      kind: 'deploy',
      target_sha: 'fffffffffff0000',
      current_step: 'build',
      status: 'failed',
      started_at: '2999-01-01T00:00:00.000Z',
      completed_at: null,
    });
    db.prepare(
      `INSERT INTO audit_log (ts, event_type, actor_type, project_id, task_id, payload) VALUES (?, 'deploy_failed', 'system', ?, 'notion:t1', ?)`,
    ).run(now, PID, JSON.stringify({ a: 1, b: { c: 2 } }));

    const snap = buildInvestigateDbSnapshot(PID, { now });

    expect(snap.project).toEqual({
      id: PID,
      name: 'Inv Snap',
      projectDir: '/nonexistent/inv-snap',
    });
    expect(snap.deployed.sha).toBe('abcdef0123456789');
    expect(snap.deployed.shortSha).toBe('abcdef0123');
    expect(snap.activeMilestone).toEqual({
      id: 'm1',
      name: 'Milestone One',
      shortId: 'M1',
      boardId: 'board-1',
    });
    expect(snap.deployHint).toContain('Live SHA is still abcdef0123');
    expect(Object.keys(snap.health).sort()).toEqual([
      'erroredSessions',
      'needsAttentionPRs',
      'recentAuditEvents',
      'recentDeploys',
      'recentPlanningSessions',
    ]);
    const err = snap.health.erroredSessions[0];
    expect(err).toMatchObject({
      sessionId: 's-err',
      preAssemblyFailure: true,
      promptFile: null,
      taskIdForms: { raw: 'notion:t1', bare: 't1', notion: 'notion:t1' },
    });
    expect(snap.health.recentPlanningSessions[0]).toMatchObject({
      sessionId: 's-groom',
      sessionType: 'groom',
      pauseReason: null,
    });
    expect(snap.health.recentDeploys[0]).toMatchObject({
      runId: 'r1',
      shortSha: 'fffffffffff'.slice(0, 10),
      completed: false,
      lastEvent: null,
    });
    expect(snap.health.recentAuditEvents[0]).toMatchObject({
      eventType: 'deploy_failed',
      payloadSummary: 'a=1 b={"c":2}',
    });
  });

  it('reports a null deployed sha and no milestone when none are recorded', () => {
    const snap = buildInvestigateDbSnapshot(PID);
    expect(snap.deployed).toEqual({
      sha: null,
      shortSha: null,
      recordedAt: null,
    });
    expect(snap.activeMilestone).toBeNull();
    expect(snap.deployHint).toContain('No deployed SHA recorded');
  });
});
