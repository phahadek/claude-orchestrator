import { enqueueRunnerJob } from './runnerJobQueue';
import { packTestSnapshot } from './testSnapshot';
import type { RunnerResultPackage } from './runnerResultPackage';
import type { TestRequestRunSpec } from './testRequestLane';

export interface LaneRunnerExecutorCtx {
  runId: string;
  spec: TestRequestRunSpec;
  startedAt: number;
  concurrentRunCount: number;
  testReportGlob: string | undefined;
}

export type LaneRunnerExecutorFn = (
  ctx: LaneRunnerExecutorCtx,
) => Promise<RunnerResultPackage>;

/**
 * Packs the worktree snapshot and hands the run to a remote runner via the job
 * queue. RunnerUnreachableError / SnapshotTooLargeError propagate to
 * executeTestRequestRun, which settles them as failed/'runner_unreachable'.
 */
export function createLaneRunnerExecutor(): LaneRunnerExecutorFn {
  return async ({ runId, spec, testReportGlob }) => {
    const snapshot = await packTestSnapshot(spec.worktreePath);
    if (!snapshot) {
      throw new Error(
        `Cannot dispatch run ${runId} to a runner: worktree has no files to snapshot`,
      );
    }
    return enqueueRunnerJob({
      runId,
      projectId: spec.projectId,
      spec: {
        commands: spec.commands,
        timeoutSec: spec.timeoutSec,
        maxRssMb: spec.maxRssMb,
        failFast: spec.failFast ?? false,
        expectedToolVersions: spec.expectedToolVersions ?? [],
      },
      snapshot,
      contentHash: spec.contentHash,
      testReportGlob: testReportGlob ?? null,
    });
  };
}
