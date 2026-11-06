import { logger } from '../logger';
import { getAllProjects } from '../config';
import type { ProjectConfig } from '../config';
import type { Scheduler } from './Scheduler';
import { getTaskBackend } from '../tasks/TaskBackend';
import type { TaskBackend } from '../tasks/TaskBackend';
import {
  findQualifyingDenialPatterns,
  recordDisqualification,
  renderInvestigationTaskBody,
  renderInvestigationTaskTitle,
  type CapabilityDenialPattern,
} from '../audit/capabilityDispositionMining';
import {
  resolveMilestoneSourceId,
  resolveMilestoneForTaskId,
  UnknownMilestoneError,
} from '../projects/milestoneResolver';
import { recordEvent } from '../audit/AuditLog';

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const INVESTIGATION_TASK_TYPE = '🔎 Investigation';

/**
 * Best-effort resolution of the milestone board a newly filed auto-deny
 * Investigation task should land on: the milestone of the most recent
 * denying task (so the Investigation surfaces next to the work that
 * triggered it), falling back to the project's configured
 * autoLaunchMilestoneId when no denying task's board can be resolved.
 */
function resolveTargetMilestone(
  project: ProjectConfig,
  pattern: CapabilityDenialPattern,
): string | null {
  for (let i = pattern.taskIds.length - 1; i >= 0; i--) {
    const milestone = resolveMilestoneForTaskId(project.id, pattern.taskIds[i]);
    if (milestone) return milestone;
  }
  return project.autoLaunchMilestoneId;
}

/**
 * Periodic auto-deny half of capability-disposition-trail mining: scans the
 * capability_request_disposition audit trail for repeated-denial patterns
 * (see audit/capabilityDispositionMining.ts for the qualification bar),
 * files a 🔎 Investigation task naming the evidence for each qualifying
 * pattern, and records the disqualification that excludes the key from
 * further mining until that Investigation resolves (see
 * ops/opsJournal.ts's setEntryState, the sole place a disqualification is
 * lifted or hardened).
 *
 * Deliberately never stages a ready 'add to GRANT_DENYLIST_PATTERNS'
 * decision item — the pattern only ever routes to human investigation, per
 * the acceptance criteria's structurally-higher auto-deny bar.
 */
export class CapabilityDispositionMiner {
  constructor(
    private readonly options: {
      listProjects?: () => ProjectConfig[];
      resolveBackend?: (projectId: string) => TaskBackend;
      intervalMs?: number;
      findPatterns?: () => CapabilityDenialPattern[];
      now?: () => string;
    } = {},
  ) {}

  register(scheduler: Scheduler): void {
    scheduler.register({
      name: 'capability_disposition_miner',
      intervalMs: () => this.options.intervalMs ?? DEFAULT_INTERVAL_MS,
      concurrency: 'skip-if-running',
      run: async () => {
        await this.scanOnce();
      },
    });
  }

  async scanOnce(): Promise<void> {
    const listProjects = this.options.listProjects ?? getAllProjects;
    const resolveBackend = this.options.resolveBackend ?? getTaskBackend;
    const findPatterns =
      this.options.findPatterns ?? findQualifyingDenialPatterns;
    const now = this.options.now ?? (() => new Date().toISOString());

    const projectsById = new Map(listProjects().map((p) => [p.id, p]));
    const patterns = findPatterns();

    for (const pattern of patterns) {
      const project = projectsById.get(pattern.projectId);
      if (!project) continue;

      try {
        await this.fileInvestigation(project, pattern, resolveBackend, now);
      } catch (err) {
        logger.warn(
          `[CapabilityDispositionMiner] failed to file Investigation for ` +
            `${pattern.projectId}/${pattern.capability}: ${(err as Error).message}`,
        );
      }
    }
  }

  private async fileInvestigation(
    project: ProjectConfig,
    pattern: CapabilityDenialPattern,
    resolveBackend: (projectId: string) => TaskBackend,
    now: () => string,
  ): Promise<void> {
    const milestone = resolveTargetMilestone(project, pattern);
    if (!milestone) {
      logger.warn(
        `[CapabilityDispositionMiner] no resolvable milestone for ` +
          `${project.id}/${pattern.capability} — skipping this cycle`,
      );
      return;
    }

    let databaseId: string;
    try {
      databaseId = resolveMilestoneSourceId(project.id, milestone);
    } catch (err) {
      if (err instanceof UnknownMilestoneError) {
        logger.warn(
          `[CapabilityDispositionMiner] ${err.message} — skipping ${project.id}/${pattern.capability}`,
        );
        return;
      }
      throw err;
    }

    const backend = resolveBackend(project.id);
    if (!backend.createTask) {
      logger.warn(
        `[CapabilityDispositionMiner] task backend for project ${project.id} does not support createTask`,
      );
      return;
    }

    const title = renderInvestigationTaskTitle(pattern);
    const taskId = await backend.createTask({
      databaseId,
      title,
      type: INVESTIGATION_TASK_TYPE,
      body: renderInvestigationTaskBody(pattern),
    });

    const nowIso = now();
    recordDisqualification(pattern, taskId, nowIso);

    recordEvent({
      event_type: 'capability_disposition_investigation_filed',
      actor_type: 'system',
      project_id: project.id,
      task_id: taskId,
      payload: {
        capability: pattern.capability,
        denialCount: pattern.denialCount,
        taskIds: pattern.taskIds,
        milestone,
      },
    });

    logger.info(
      `[CapabilityDispositionMiner] filed Investigation ${taskId} for repeated ` +
        `denial of "${pattern.capability}" in ${project.id} (${pattern.denialCount} denials, ` +
        `${pattern.taskIds.length} tasks)`,
    );
  }
}
