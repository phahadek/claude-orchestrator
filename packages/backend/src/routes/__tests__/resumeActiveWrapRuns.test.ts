/**
 * Tests for resumeActiveWrapRuns (packages/backend/src/routes/deploy.ts).
 *
 * AC: an interrupted wrap run (status still 'running' after a simulated
 * backend restart) is rediscovered at boot and re-driven from its recorded
 * launch params — the wrap-kind mirror of resumeActiveDeployRuns, without
 * which an orphaned wrap run would permanently hold the (project, 'wrap')
 * exclusivity lock. A run with no recorded launch params (predates the
 * mechanism, or crashed before they were recorded) is failed outright so
 * the lock still clears rather than staying stuck forever.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import {
  insertProject,
  insertMilestone,
  getProjectRowById,
} from '../../db/queries.js';
import { resumeActiveWrapRuns } from '../deploy.js';
import {
  startDeployRun,
  getActiveDeployRun,
  getDeployRun,
} from '../../deploy/deployService.js';
import {
  recordWrapLaunchParams,
  WRAP_STEP_CONFIRM_REPOINT,
} from '../../deploy/wrapPlaybook.js';

const PROJECT = 'wrap-resume-project';
const CLOSING_MILESTONE = 'closing-milestone-id';
const NEXT_MILESTONE = 'next-milestone-id';

/** Flush pending microtasks so the fire-and-forget resume()/drive() loop settles. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  db.prepare('DELETE FROM deploy_run_event').run();
  db.prepare('DELETE FROM deploy_run').run();
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM milestones').run();
  db.prepare('DELETE FROM projects').run();

  insertProject({
    id: PROJECT,
    name: 'Wrap Resume Project',
    project_dir: '/tmp/wrap-resume-project',
    context_url: null,
    github_repo: 'acme/wrap-resume-project',
    task_source: 'notion',
  });
  insertMilestone({
    id: CLOSING_MILESTONE,
    project_id: PROJECT,
    name: 'M1',
    source_id: null,
    canonical_short_id: 'M1',
  });
  insertMilestone({
    id: NEXT_MILESTONE,
    project_id: PROJECT,
    name: 'M2',
    source_id: null,
    canonical_short_id: 'M2',
  });
});

describe('resumeActiveWrapRuns', () => {
  it('is a no-op for a project with no active wrap run', () => {
    const project = getProjectRowById(PROJECT)!;
    expect(() => resumeActiveWrapRuns([project])).not.toThrow();
    expect(getActiveDeployRun(PROJECT, 'wrap')).toBeUndefined();
  });

  it('re-drives an orphaned wrap run from its recorded launch params, executing its directive steps and stopping at the first confirm-gate', async () => {
    const run = startDeployRun({
      project: PROJECT,
      kind: 'wrap',
      targetSha: CLOSING_MILESTONE,
      startedAt: '2026-08-24T00:00:00.000Z',
    });
    recordWrapLaunchParams(
      run.run_id,
      {
        projectId: PROJECT,
        closingMilestoneId: CLOSING_MILESTONE,
        nextMilestoneId: NEXT_MILESTONE,
        releaseVersion: '1.9.0',
        repoUrl: 'https://github.com/acme/wrap-resume-project.git',
      },
      '2026-08-24T00:00:00.000Z',
    );

    const project = getProjectRowById(PROJECT)!;
    resumeActiveWrapRuns([project]);
    await flush();

    // Step 1 (mark-wrapped) and step 2 (carry-gate-items) ran for real —
    // the milestone is wrapped — and the run is now parked at the first
    // confirm-gate (still 'running', not stuck at null/step 1).
    const milestoneRow = db
      .prepare('SELECT wrapped_at FROM milestones WHERE id = ?')
      .get(CLOSING_MILESTONE) as { wrapped_at: number | null };
    expect(milestoneRow.wrapped_at).not.toBeNull();

    const resumed = getDeployRun(run.run_id);
    expect(resumed?.status).toBe('running');
    expect(resumed?.current_step).toBe(WRAP_STEP_CONFIRM_REPOINT);
    expect(getActiveDeployRun(PROJECT, 'wrap')?.run_id).toBe(run.run_id);
  });

  it('fails a run with no recorded launch params rather than leaving it stuck, clearing the exclusivity lock', async () => {
    startDeployRun({
      project: PROJECT,
      kind: 'wrap',
      targetSha: CLOSING_MILESTONE,
      startedAt: '2026-08-24T00:00:00.000Z',
    });
    // No recordWrapLaunchParams call — simulates a run that predates the
    // mechanism, or crashed before its params were recorded.

    const project = getProjectRowById(PROJECT)!;
    resumeActiveWrapRuns([project]);
    await flush();

    expect(getActiveDeployRun(PROJECT, 'wrap')).toBeUndefined();
    // A subsequent wrap launch is no longer blocked by a stuck lock.
    expect(() =>
      startDeployRun({
        project: PROJECT,
        kind: 'wrap',
        targetSha: CLOSING_MILESTONE,
        startedAt: '2026-08-24T00:05:00.000Z',
      }),
    ).not.toThrow();
  });

  it("only touches the project's own wrap lock, leaving an active deploy run for the same project untouched", async () => {
    const deployRun = startDeployRun({
      project: PROJECT,
      kind: 'deploy',
      targetSha: 'sha-1',
      startedAt: '2026-08-24T00:00:00.000Z',
    });
    const wrapRun = startDeployRun({
      project: PROJECT,
      kind: 'wrap',
      targetSha: CLOSING_MILESTONE,
      startedAt: '2026-08-24T00:00:00.000Z',
    });
    recordWrapLaunchParams(
      wrapRun.run_id,
      {
        projectId: PROJECT,
        closingMilestoneId: CLOSING_MILESTONE,
        nextMilestoneId: NEXT_MILESTONE,
        releaseVersion: '1.9.0',
        repoUrl: 'https://github.com/acme/wrap-resume-project.git',
      },
      '2026-08-24T00:00:00.000Z',
    );

    const project = getProjectRowById(PROJECT)!;
    resumeActiveWrapRuns([project]);
    await flush();

    expect(getActiveDeployRun(PROJECT, 'deploy')?.run_id).toBe(
      deployRun.run_id,
    );
    expect(getDeployRun(deployRun.run_id)?.status).toBe('running');
  });
});
