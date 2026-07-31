import { ProjectService } from '../projects/ProjectService';
import type { ProjectMilestone } from '../projects/ProjectService';
import {
  resolveMilestoneRowForProject,
  canonicalMilestoneKey,
  UnknownMilestoneError,
} from '../projects/milestoneResolver';
import { getGateReadiness } from '../gate/gateService';
import { getSeedReadiness } from '../seed/seedService';
import { getOpsReadiness } from './opsReadiness';
import { getTaskCache } from '../db/queries';
import { runtimeSettings } from '../config';
import type { NotionTask } from '../notion/types';

/** Notion status tokens (`.includes`-matched, same convention as TaskStatusEngine) that keep a task open. */
const OPEN_STATUS_TOKENS = [
  'Backlog',
  'Ready',
  'In Progress',
  'In Review',
  'Blocked',
];
/** Notion status tokens that close a task out. */
const CLOSED_STATUS_TOKENS = ['Done', 'Deferred'];

function isOpenTaskStatus(status: string): boolean {
  return OPEN_STATUS_TOKENS.some((token) => status.includes(token));
}

function isClosedTaskStatus(status: string): boolean {
  return CLOSED_STATUS_TOKENS.some((token) => status.includes(token));
}

type TaskAxisStatus = 'green' | 'blocked' | 'unavailable';

interface TaskAxisBlockingItem {
  id: string;
  title: string;
  status: string;
}

interface TaskAxis {
  status: TaskAxisStatus;
  open: number;
  closed: number;
  blocking: TaskAxisBlockingItem[];
}

interface GateAxisBlockingItem {
  id: string;
  text: string;
  state: string;
}

interface GateAxis {
  status: 'green' | 'blocked';
  blockingCount: number;
  /** Subset of blocking items sitting in a bespoke (unrecognized) state — needs human re-disposition, distinct from the blocking total. */
  bespokeCount: number;
  blocking: GateAxisBlockingItem[];
}

interface SeedAxisBlockingItem {
  id: string;
  text: string;
  state: string;
}

interface SeedAxis {
  status: 'green' | 'blocked';
  blockingCount: number;
  blocking: SeedAxisBlockingItem[];
}

interface OpsAxisBlockingItem {
  task_id: string;
  state: string;
}

interface OpsAxis {
  status: 'green' | 'blocked';
  blockingCount: number;
  blocking: OpsAxisBlockingItem[];
}

export interface MilestoneConvergence {
  project: string;
  milestone: string;
  status: 'green' | 'blocked';
  distanceToGreen: number;
  axes: {
    tasks: TaskAxis;
    gate: GateAxis;
    seed: SeedAxis;
    ops: OpsAxis;
  };
}

const UNAVAILABLE_TASK_AXIS: TaskAxis = {
  status: 'unavailable',
  open: 0,
  closed: 0,
  blocking: [],
};

/**
 * The Notion task axis: counted at request time over the board's task_cache
 * row (keyed `board:${milestone.id}`, populated by TaskCacheRefresher).
 * Absent, unparseable, or stale-past-freshness reports 'unavailable' — never
 * 'green' — so a cold/broken cache can't masquerade as an empty (green) board.
 * A source_id-null milestone never gets a board cache written in the first
 * place, so it degrades to the same 'unavailable' outcome.
 */
function getTaskAxis(milestone: ProjectMilestone): TaskAxis {
  if (!milestone.sourceId) {
    return UNAVAILABLE_TASK_AXIS;
  }

  const row = getTaskCache(`board:${milestone.id}`);
  if (!row) {
    return UNAVAILABLE_TASK_AXIS;
  }

  const freshnessMs = runtimeSettings.task_cache_refresh_interval_ms * 2;
  if (Date.now() - row.fetched_at > freshnessMs) {
    return UNAVAILABLE_TASK_AXIS;
  }

  let tasks: NotionTask[];
  try {
    tasks = JSON.parse(row.raw_json) as NotionTask[];
  } catch {
    return UNAVAILABLE_TASK_AXIS;
  }

  const blocking = tasks
    .filter((t) => isOpenTaskStatus(t.status))
    .map((t) => ({ id: t.id, title: t.title, status: t.status }));
  const closed = tasks.filter((t) => isClosedTaskStatus(t.status)).length;

  return {
    status: blocking.length === 0 ? 'green' : 'blocked',
    open: blocking.length,
    closed,
    blocking,
  };
}

/**
 * Single-milestone convergence read: composes the four readiness axes
 * (Notion tasks, gate, seed, ops) at request time — no persisted rollup.
 * Green iff every axis is green; distanceToGreen deliberately excludes the
 * ops axis (an ops_journal row is already an ops-typed task counted on the
 * task axis — adding it again would double-count).
 */
export function getMilestoneConvergence(
  projectId: string,
  milestoneRef: string,
): MilestoneConvergence {
  const milestoneRow = resolveMilestoneRowForProject(projectId, milestoneRef);
  const key = canonicalMilestoneKey(milestoneRow);

  const tasks = getTaskAxis(milestoneRow);

  const gateReadiness = getGateReadiness(projectId, key);
  const gate: GateAxis = {
    status: gateReadiness.status,
    blockingCount: gateReadiness.blocking.length,
    bespokeCount: gateReadiness.bespokeStates.length,
    blocking: gateReadiness.blocking.map((b) => ({
      id: b.id,
      text: b.text,
      state: b.state,
    })),
  };

  const seedReadiness = getSeedReadiness(projectId, key);
  const seed: SeedAxis = {
    status: seedReadiness.status,
    blockingCount: seedReadiness.blocking.length,
    blocking: seedReadiness.blocking.map((b) => ({
      id: b.id,
      text: b.spec,
      state: b.state,
    })),
  };

  const opsReadiness = getOpsReadiness(projectId, key);
  const ops: OpsAxis = {
    status: opsReadiness.status,
    blockingCount: opsReadiness.blockingCount,
    blocking: opsReadiness.blocking,
  };

  const allGreen =
    tasks.status === 'green' &&
    gate.status === 'green' &&
    seed.status === 'green' &&
    ops.status === 'green';

  const distanceToGreen = tasks.open + gate.blockingCount + seed.blockingCount;

  return {
    project: projectId,
    milestone: key,
    status: allGreen ? 'green' : 'blocked',
    distanceToGreen,
    axes: { tasks, gate, seed, ops },
  };
}

export interface MilestoneConvergenceSummary {
  milestone: string;
  status: 'green' | 'blocked';
  distanceToGreen: number;
  axes: {
    tasks: { status: TaskAxisStatus; open: number; closed: number };
    gate: { status: 'green' | 'blocked'; blockingCount: number };
    seed: { status: 'green' | 'blocked'; blockingCount: number };
    ops: { status: 'green' | 'blocked'; blockingCount: number };
  };
}

/**
 * Every non-Done milestone's convergence summary for a project — active
 * (project.autoLaunchMilestoneId) and in-planning (any other non-done
 * milestone) alike, scoped by wrapped_at IS NULL.
 */
export function listProjectConvergence(
  projectId: string,
): MilestoneConvergenceSummary[] {
  const project = ProjectService.getById(projectId);
  if (!project) {
    throw new UnknownMilestoneError(`unknown project "${projectId}"`);
  }

  return project.milestones
    .filter((m) => m.wrappedAt == null)
    .map((m) => {
      const full = getMilestoneConvergence(projectId, canonicalMilestoneKey(m));
      return {
        milestone: full.milestone,
        status: full.status,
        distanceToGreen: full.distanceToGreen,
        axes: {
          tasks: {
            status: full.axes.tasks.status,
            open: full.axes.tasks.open,
            closed: full.axes.tasks.closed,
          },
          gate: {
            status: full.axes.gate.status,
            blockingCount: full.axes.gate.blockingCount,
          },
          seed: {
            status: full.axes.seed.status,
            blockingCount: full.axes.seed.blockingCount,
          },
          ops: {
            status: full.axes.ops.status,
            blockingCount: full.axes.ops.blockingCount,
          },
        },
      };
    });
}
