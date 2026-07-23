/**
 * Tests for deployService (packages/backend/src/deploy/deployService.ts).
 *
 * AC: reportProjectDeploy records a project's SHA; getProjectDeployedSha
 * reads it back; an unknown/never-reported project reads back null. This is
 * the orchestrator-owned deployed-SHA record — reported in, never read from
 * a deploy-written file.
 */

import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import {
  reportProjectDeploy,
  getProjectDeployedSha,
  startDeployRun,
  getDeployRun,
  getActiveDeployRun,
  getLatestDeployRun,
  advanceDeployRun,
  completeDeployRun,
  appendDeployRunEvent,
  listDeployRunEvents,
  DeployRunConflictError,
} from '../deployService.js';

beforeEach(() => {
  db.prepare('DELETE FROM project_deployed_sha').run();
  db.prepare('DELETE FROM deploy_run_event').run();
  db.prepare('DELETE FROM deploy_run').run();
});

describe('reportProjectDeploy / getProjectDeployedSha', () => {
  it('records a projects deployed sha and reads it back', () => {
    reportProjectDeploy('claude-orchestrator', 'abc123');
    expect(getProjectDeployedSha('claude-orchestrator')).toBe('abc123');
  });

  it('returns null for a project that has never reported in', () => {
    expect(getProjectDeployedSha('never-reported')).toBeNull();
  });

  it('overwrites the prior sha on a subsequent report', () => {
    reportProjectDeploy('claude-orchestrator', 'abc123');
    reportProjectDeploy('claude-orchestrator', 'def456');
    expect(getProjectDeployedSha('claude-orchestrator')).toBe('def456');
  });

  it('tracks each project independently', () => {
    reportProjectDeploy('claude-orchestrator', 'abc123');
    reportProjectDeploy('polimarket-analyser', 'zzz999');
    expect(getProjectDeployedSha('claude-orchestrator')).toBe('abc123');
    expect(getProjectDeployedSha('polimarket-analyser')).toBe('zzz999');
  });
});

describe('deploy_run: run-state store', () => {
  it('starts a run and reads it back', () => {
    const run = startDeployRun({
      project: 'claude-orchestrator',
      targetSha: 'sha1',
      startedAt: '2026-07-20T00:00:00.000Z',
    });
    expect(run.status).toBe('running');
    expect(run.current_step).toBeNull();
    expect(getDeployRun(run.run_id)).toEqual(run);
    expect(getActiveDeployRun('claude-orchestrator')).toEqual(run);
  });

  it('advances the step pointer and completes the run', () => {
    const run = startDeployRun({
      project: 'claude-orchestrator',
      targetSha: 'sha1',
      startedAt: '2026-07-20T00:00:00.000Z',
    });
    advanceDeployRun(run.run_id, 'deploy-backend');
    expect(getDeployRun(run.run_id)?.current_step).toBe('deploy-backend');

    completeDeployRun(run.run_id, 'succeeded', '2026-07-20T00:05:00.000Z');
    const completed = getDeployRun(run.run_id);
    expect(completed?.status).toBe('succeeded');
    expect(completed?.completed_at).toBe('2026-07-20T00:05:00.000Z');
    expect(getActiveDeployRun('claude-orchestrator')).toBeUndefined();
  });

  it('appends and reads back deploy_run_events in order', () => {
    const run = startDeployRun({
      project: 'claude-orchestrator',
      targetSha: 'sha1',
      startedAt: '2026-07-20T00:00:00.000Z',
    });
    appendDeployRunEvent({
      runId: run.run_id,
      step: 'deploy-backend',
      eventType: 'step_started',
      at: '2026-07-20T00:00:01.000Z',
    });
    appendDeployRunEvent({
      runId: run.run_id,
      step: 'deploy-backend',
      eventType: 'confirm_gate',
      disposition: 'approved',
      at: '2026-07-20T00:00:02.000Z',
    });
    const events = listDeployRunEvents(run.run_id);
    expect(events.map((e) => e.event_type)).toEqual([
      'step_started',
      'confirm_gate',
    ]);
    expect(events[1].disposition).toBe('approved');
  });

  it('enforces at most one active run per project', () => {
    startDeployRun({
      project: 'claude-orchestrator',
      targetSha: 'sha1',
      startedAt: '2026-07-20T00:00:00.000Z',
    });
    expect(() =>
      startDeployRun({
        project: 'claude-orchestrator',
        targetSha: 'sha2',
        startedAt: '2026-07-20T00:01:00.000Z',
      }),
    ).toThrow(DeployRunConflictError);
  });

  it('allows a new active run once the prior run completed', () => {
    const first = startDeployRun({
      project: 'claude-orchestrator',
      targetSha: 'sha1',
      startedAt: '2026-07-20T00:00:00.000Z',
    });
    completeDeployRun(first.run_id, 'succeeded', '2026-07-20T00:05:00.000Z');
    const second = startDeployRun({
      project: 'claude-orchestrator',
      targetSha: 'sha2',
      startedAt: '2026-07-20T00:06:00.000Z',
    });
    expect(getActiveDeployRun('claude-orchestrator')).toEqual(second);
  });

  it('getLatestDeployRun returns the active run when one is running', () => {
    const run = startDeployRun({
      project: 'claude-orchestrator',
      targetSha: 'sha1',
      startedAt: '2026-07-20T00:00:00.000Z',
    });
    expect(getLatestDeployRun('claude-orchestrator')).toEqual(run);
  });

  it('getLatestDeployRun falls back to the most recent terminal run when none is active', () => {
    const run = startDeployRun({
      project: 'claude-orchestrator',
      targetSha: 'sha1',
      startedAt: '2026-07-20T00:00:00.000Z',
    });
    completeDeployRun(run.run_id, 'failed', '2026-07-20T00:05:00.000Z');
    const latest = getLatestDeployRun('claude-orchestrator');
    expect(latest?.run_id).toBe(run.run_id);
    expect(latest?.status).toBe('failed');
  });

  it('getLatestDeployRun returns undefined when the project has never deployed', () => {
    expect(getLatestDeployRun('never-deployed')).toBeUndefined();
  });

  it('scopes active-run tracking independently per project', () => {
    const a = startDeployRun({
      project: 'claude-orchestrator',
      targetSha: 'sha1',
      startedAt: '2026-07-20T00:00:00.000Z',
    });
    const b = startDeployRun({
      project: 'polimarket-analyser',
      targetSha: 'sha9',
      startedAt: '2026-07-20T00:00:00.000Z',
    });
    expect(getActiveDeployRun('claude-orchestrator')).toEqual(a);
    expect(getActiveDeployRun('polimarket-analyser')).toEqual(b);
  });
});

describe('report-in helper posts the deployed sha', () => {
  it('reportProjectDeploy is the helper the engine calls after verification', () => {
    reportProjectDeploy('claude-orchestrator', 'deployed-sha');
    expect(getProjectDeployedSha('claude-orchestrator')).toBe('deployed-sha');
  });
});

describe('deploy is reported in, never read from a deploy-written file', () => {
  it('the deployService source touches no filesystem read of a deploy-written SHA file', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../deployService.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/readFile|DEPLOYED_SHA/i);
  });
});
