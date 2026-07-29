import { logger } from '../logger';
import type { Scheduler } from './Scheduler';
import { getAllProjects } from '../config';
import type { ProjectConfig } from '../config';
import { ProjectService } from '../projects/ProjectService';
import type { ProjectMilestone } from '../projects/ProjectService';
import { canonicalMilestoneKey } from '../projects/milestoneResolver';
import { getMilestoneConvergence } from '../convergence/convergenceService';
import { getGateReadiness } from '../gate/gateService';
import { getSeedReadiness } from '../seed/seedService';
import { getOpsReadiness } from '../convergence/opsReadiness';
import {
  insertConvergenceSnapshot,
  getLatestConvergenceSnapshot,
  listOpsJournalEntries,
} from '../db/queries';
import type { ConvergenceSnapshotRow } from '../db/types';

const INTERVAL_MS = 5 * 60_000;

function sumCounts(counts: Record<string, number>): number {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

type SnapshotFields = Omit<ConvergenceSnapshotRow, 'id' | 'ts'>;

function sameSnapshot(
  latest: ConvergenceSnapshotRow,
  next: SnapshotFields,
): boolean {
  return (
    latest.tasks_open === next.tasks_open &&
    latest.tasks_closed === next.tasks_closed &&
    latest.gate_open === next.gate_open &&
    latest.gate_closed === next.gate_closed &&
    latest.seed_open === next.seed_open &&
    latest.seed_closed === next.seed_closed &&
    latest.ops_open === next.ops_open &&
    latest.ops_closed === next.ops_closed &&
    latest.total_scope === next.total_scope &&
    latest.distance_to_green === next.distance_to_green &&
    latest.status === next.status
  );
}

/**
 * Samples the live milestone convergence (convergenceService) every 5 minutes
 * for every non-Done milestone across projects, and writes a convergence_snapshot
 * row only when it differs from that milestone's latest stored snapshot — an
 * idle milestone costs ~0 rows, so each stored row is a real transition.
 *
 * Never recomputes the axes: the tasks axis is read straight off
 * getMilestoneConvergence, and the gate/seed/ops open-vs-closed split is read
 * off the same readiness services convergenceService itself composes over.
 */
export class ConvergenceSnapshotJob {
  constructor(
    private readonly options: {
      listProjects?: () => ProjectConfig[];
    } = {},
  ) {}

  register(scheduler: Scheduler): void {
    scheduler.register({
      name: 'convergence_snapshot',
      intervalMs: INTERVAL_MS,
      runOnBoot: true,
      concurrency: 'skip-if-running',
      run: async () => this.runOnce(),
      onError: (err: unknown) =>
        logger.warn(
          '[ConvergenceSnapshotJob] tick error:',
          (err as Error).message,
        ),
    });
  }

  async runOnce(): Promise<{ items_processed: number }> {
    const listProjects = this.options.listProjects ?? getAllProjects;
    const projects = listProjects();
    let itemsProcessed = 0;

    for (const project of projects) {
      const milestones = ProjectService.listMilestones(project.id).filter(
        (m) => m.wrappedAt == null,
      );
      for (const milestone of milestones) {
        try {
          this.sampleMilestone(project.id, milestone);
          itemsProcessed++;
        } catch (err) {
          logger.warn(
            `[ConvergenceSnapshotJob] failed to sample project=${project.id} milestone=${milestone.name}: ${String(err)}`,
          );
        }
      }
    }

    return { items_processed: itemsProcessed };
  }

  private sampleMilestone(
    projectId: string,
    milestone: ProjectMilestone,
  ): void {
    const key = canonicalMilestoneKey(milestone);
    const convergence = getMilestoneConvergence(projectId, key);

    const gateReadiness = getGateReadiness(key);
    const gateOpen = gateReadiness.blocking.length;
    const gateClosed = sumCounts(gateReadiness.counts) - gateOpen;

    const seedReadiness = getSeedReadiness(key);
    const seedOpen = seedReadiness.blocking.length;
    const seedClosed = sumCounts(seedReadiness.counts) - seedOpen;

    const opsReadiness = getOpsReadiness(projectId, key);
    const opsOpen = opsReadiness.blockingCount;
    const opsTotal = listOpsJournalEntries().filter(
      (e) => e.project === projectId && e.milestone === key,
    ).length;
    const opsClosed = opsTotal - opsOpen;

    const tasksOpen = convergence.axes.tasks.open;
    const tasksClosed = convergence.axes.tasks.closed;

    const totalScope =
      tasksOpen +
      tasksClosed +
      gateOpen +
      gateClosed +
      seedOpen +
      seedClosed +
      opsOpen +
      opsClosed;

    const snapshot: SnapshotFields = {
      project: projectId,
      milestone: key,
      tasks_open: tasksOpen,
      tasks_closed: tasksClosed,
      gate_open: gateOpen,
      gate_closed: gateClosed,
      seed_open: seedOpen,
      seed_closed: seedClosed,
      ops_open: opsOpen,
      ops_closed: opsClosed,
      total_scope: totalScope,
      distance_to_green: convergence.distanceToGreen,
      status: convergence.status,
    };

    const latest = getLatestConvergenceSnapshot(projectId, key);
    if (latest && sameSnapshot(latest, snapshot)) {
      return;
    }

    insertConvergenceSnapshot({ ...snapshot, ts: new Date().toISOString() });
  }
}
