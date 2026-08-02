/**
 * Tests for DeployAgenticStepSpawner (packages/backend/src/routes/deploy.ts).
 *
 * AC: a still-live prior session for the same run/step is reattached rather
 * than re-dispatched; a crashed prior session is dispatched fresh; a budget
 * expiry auto-settles to `inconclusive` and tears the session down, which
 * (wired to a real DeployOrchestrator) releases the per-project run lock
 * (deploy_run.status leaves 'running').
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../../config', () => ({
  getProjectById: vi
    .fn()
    .mockReturnValue({ contextUrl: 'https://notion.so/project' }),
}));

import { db } from '../../db/db.js';
import { DeployAgenticStepSpawner } from '../deploy';
import {
  DeployOrchestrator,
  buildDeployAgenticTaskId,
  type DeployOrchestratorDeps,
} from '../../deploy/DeployOrchestrator';
import { getDeployRun } from '../../deploy/deployService';
import { insertSessionOrIgnore } from '../../db/queries';
import type {
  DeployPlaybook,
  StepDescriptor,
} from '../../deploy/playbookSchema';
import type { LoadPlaybookResult } from '../../deploy/loadPlaybook';

beforeEach(() => {
  db.prepare('DELETE FROM deploy_run_event').run();
  db.prepare('DELETE FROM deploy_run').run();
  db.prepare('DELETE FROM sessions').run();
});

function makeSessionManager() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    start: vi.fn(),
    archiveAndEndSession: vi.fn(),
  });
}

const step: StepDescriptor = {
  id: 'investigate',
  kind: 'agentic',
  command_or_prompt: 'investigate whether the rollout is healthy',
  is_prod_mutating: false,
};

describe('DeployAgenticStepSpawner: reattach vs fresh dispatch', () => {
  it('reattaches to a still-live prior session for the same run/step instead of dispatching a duplicate', () => {
    const runId = 'run-live';
    const taskId = buildDeployAgenticTaskId(runId, step.id);
    insertSessionOrIgnore({
      session_id: 'sess-live',
      task_id: taskId,
      task_url: taskId,
      project_context_url: 'https://notion.so/project',
      status: 'running',
      started_at: Date.now(),
      session_type: 'ops',
    });

    const sessionManager = makeSessionManager();
    const orchestrator = { reportAgenticVerdict: vi.fn() };
    const spawner = new DeployAgenticStepSpawner(
      sessionManager as never,
      () => orchestrator as never,
    );

    spawner.spawn({ runId, project: 'proj', step });

    expect(sessionManager.start).not.toHaveBeenCalled();

    sessionManager.emit('deploy_agentic_verdict', {
      sessionId: 'sess-live',
      projectId: 'proj',
      runId,
      stepId: step.id,
      verdict: 'approved',
    });

    expect(orchestrator.reportAgenticVerdict).toHaveBeenCalledWith(
      runId,
      step.id,
      'approved',
      undefined,
    );
    expect(sessionManager.archiveAndEndSession).toHaveBeenCalledWith(
      'sess-live',
    );
  });

  it('dispatches fresh when the prior session for that run/step crashed', async () => {
    const runId = 'run-crashed';
    const taskId = buildDeployAgenticTaskId(runId, step.id);
    insertSessionOrIgnore({
      session_id: 'sess-crashed',
      task_id: taskId,
      task_url: taskId,
      project_context_url: 'https://notion.so/project',
      status: 'error',
      started_at: Date.now(),
      session_type: 'ops',
    });

    const sessionManager = makeSessionManager();
    sessionManager.start.mockResolvedValue('sess-fresh');
    const orchestrator = { reportAgenticVerdict: vi.fn() };
    const spawner = new DeployAgenticStepSpawner(
      sessionManager as never,
      () => orchestrator as never,
    );

    spawner.spawn({ runId, project: 'proj', step });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sessionManager.start).toHaveBeenCalledTimes(1);
    const [dispatchedTaskId, , dispatchOpts] = sessionManager.start.mock
      .calls[0] as [string, string, { taskId: string }];
    expect(dispatchedTaskId).toBe(taskId);
    expect(dispatchOpts.taskId).toBe(taskId);
  });
});

describe('DeployAgenticStepSpawner: budget timeout', () => {
  it('auto-settles to inconclusive on budget expiry and releases the per-project run lock', async () => {
    vi.useFakeTimers();
    try {
      const playbook: DeployPlaybook = {
        steps: [step],
        hazards: [],
        failure_diagnoses: [],
        companions: [],
      };
      const loadResult: LoadPlaybookResult = { ok: true, playbook };

      const sessionManager = makeSessionManager();
      sessionManager.start.mockImplementation(
        async (
          taskUrl: string,
          contextUrl: string,
          options: { taskId: string },
        ) => {
          insertSessionOrIgnore({
            session_id: 'sess-timeout',
            task_id: options.taskId,
            task_url: taskUrl,
            project_context_url: contextUrl,
            status: 'running',
            started_at: Date.now(),
            session_type: 'ops',
          });
          return 'sess-timeout';
        },
      );

      const orchestrators = new Map<string, DeployOrchestrator>();
      const spawner = new DeployAgenticStepSpawner(
        sessionManager as never,
        (project) => orchestrators.get(project),
        { budgetMs: 1000 },
      );

      const deps: DeployOrchestratorDeps = {
        loadPlaybook: () => loadResult,
        waitForConfirmGate: async () => true,
        spawnAgenticStep: (input) => spawner.spawn(input),
      };
      const orchestrator = new DeployOrchestrator('proj', '/tmp/proj', deps);
      orchestrators.set('proj', orchestrator);

      const run = await orchestrator.startDeploy('sha-target');
      await vi.advanceTimersByTimeAsync(0);

      expect(getDeployRun(run.run_id)?.status).toBe('running');
      expect(sessionManager.start).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);

      const completed = getDeployRun(run.run_id);
      expect(completed?.status).toBe('failed');
      expect(sessionManager.archiveAndEndSession).toHaveBeenCalledWith(
        'sess-timeout',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
