import type { NotionTask } from '../notion/types';
import {
  listTaskExecutionFlagsForProject,
  isExecuteNowExpired,
} from '../db/queries';
import { normalizeTaskId } from '../tasks/taskId';

export type ExecutionGroup = 'execute_now' | 'urgent' | 'blocker' | 'priority';
export type AssignedPriority = 'high' | 'medium' | 'low' | null;

export interface RankInputTask {
  id: string;
  status: string;
  dependsOn: string[];
  priority: AssignedPriority;
}

export interface RankInputFlags {
  urgent: boolean;
  executeNowReason: string | null;
  executeNowSetAt: number | null;
}

export interface ExecutionRank {
  group: ExecutionGroup;
  urgent: boolean;
  urgentInherited: boolean;
  urgentVia: string[];
  blocksCount: number;
  priority: AssignedPriority;
  executeNowSetAt: number | null;
}

export type TieBreak = ReadonlyArray<number | string>;

const GROUP_ORDER: Record<ExecutionGroup, number> = {
  execute_now: 0,
  urgent: 1,
  blocker: 2,
  priority: 3,
};

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

function isUnfinished(status: string): boolean {
  return !status.includes('Done');
}

function priorityRank(p: AssignedPriority): number {
  return p === null ? 3 : PRIORITY_ORDER[p];
}

export function computeExecutionRanks(
  tasks: RankInputTask[],
  flags: ReadonlyMap<string, RankInputFlags>,
): Map<string, ExecutionRank> {
  const byId = new Map<string, RankInputTask>();
  for (const t of tasks) byId.set(t.id, t);

  // dependents.get(x) = tasks in the board that list x in dependsOn
  const dependents = new Map<string, string[]>();
  for (const t of byId.values()) {
    for (const dep of new Set(t.dependsOn)) {
      if (!byId.has(dep) || dep === t.id) continue;
      let list = dependents.get(dep);
      if (!list) dependents.set(dep, (list = []));
      list.push(t.id);
    }
  }

  const blocksCount = new Map<string, number>();
  for (const id of byId.keys()) {
    const seen = new Set<string>([id]);
    const stack = [...(dependents.get(id) ?? [])];
    let count = 0;
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (isUnfinished(byId.get(cur)!.status)) count++;
      stack.push(...(dependents.get(cur) ?? []));
    }
    blocksCount.set(id, count);
  }

  // Walk each directly-urgent unfinished task's ancestors.
  const via = new Map<string, Set<string>>();
  for (const t of byId.values()) {
    if (!isUnfinished(t.status) || !flags.get(t.id)?.urgent) continue;
    const seen = new Set<string>([t.id]);
    const stack = [...t.dependsOn];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const node = byId.get(cur);
      if (!node) continue;
      if (isUnfinished(node.status)) {
        let set = via.get(cur);
        if (!set) via.set(cur, (set = new Set()));
        set.add(t.id);
      }
      stack.push(...node.dependsOn);
    }
  }

  const ranks = new Map<string, ExecutionRank>();
  for (const t of byId.values()) {
    const f = flags.get(t.id);
    const unfinished = isUnfinished(t.status);
    const urgent = unfinished && !!f?.urgent;
    const urgentVia = unfinished ? [...(via.get(t.id) ?? [])].sort() : [];
    const urgentInherited = urgentVia.length > 0;
    const count = blocksCount.get(t.id) ?? 0;
    const executeNowReason = unfinished ? (f?.executeNowReason ?? null) : null;

    let group: ExecutionGroup;
    if (executeNowReason !== null) group = 'execute_now';
    else if (urgent || urgentInherited) group = 'urgent';
    else if (count >= 1) group = 'blocker';
    else group = 'priority';

    ranks.set(t.id, {
      group,
      urgent,
      urgentInherited,
      urgentVia,
      blocksCount: count,
      priority: t.priority,
      executeNowSetAt: f?.executeNowSetAt ?? null,
    });
  }
  return ranks;
}

function compareTieBreak(a: TieBreak, b: TieBreak): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
    if (typeof x === 'string' && typeof y === 'string') return x < y ? -1 : 1;
    return typeof x === 'number' ? -1 : 1;
  }
  return a.length - b.length;
}

export function compareExecutionRank(
  a: ExecutionRank & { tieBreak: TieBreak },
  b: ExecutionRank & { tieBreak: TieBreak },
): number {
  if (a.group !== b.group) return GROUP_ORDER[a.group] - GROUP_ORDER[b.group];

  switch (a.group) {
    case 'execute_now': {
      const x = a.executeNowSetAt ?? Infinity;
      const y = b.executeNowSetAt ?? Infinity;
      if (x !== y) return x < y ? -1 : 1;
      break;
    }
    case 'urgent': {
      if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
      const d = priorityRank(a.priority) - priorityRank(b.priority);
      if (d !== 0) return d;
      break;
    }
    case 'blocker': {
      if (a.blocksCount !== b.blocksCount) return b.blocksCount - a.blocksCount;
      const d = priorityRank(a.priority) - priorityRank(b.priority);
      if (d !== 0) return d;
      break;
    }
    case 'priority': {
      const d = priorityRank(a.priority) - priorityRank(b.priority);
      if (d !== 0) return d;
      break;
    }
  }
  return compareTieBreak(a.tieBreak, b.tieBreak);
}

export function executionGroupOrder(group: ExecutionGroup): number {
  return GROUP_ORDER[group];
}

/** Within-group sort key: lexicographic ascending order matches compareExecutionRank (minus tieBreak). */
export function executionRankKey(r: ExecutionRank): (number | string)[] {
  const p = priorityRank(r.priority);
  switch (r.group) {
    case 'execute_now':
      return [r.executeNowSetAt ?? Infinity];
    case 'urgent':
      return [r.urgent ? 0 : 1, p];
    case 'blocker':
      return [-r.blocksCount, p];
    case 'priority':
      return [p];
  }
}

export function countEffectiveUrgent(ranks: Iterable<ExecutionRank>): {
  direct: number;
  effective: number;
} {
  let direct = 0;
  let effective = 0;
  for (const r of ranks) {
    if (r.urgent) direct++;
    if (r.urgent || r.urgentInherited) effective++;
  }
  return { direct, effective };
}

function parsePriority(p: string | undefined): AssignedPriority {
  if (!p) return null;
  const s = p.toLowerCase();
  if (s.includes('high')) return 'high';
  if (s.includes('medium')) return 'medium';
  if (s.includes('low')) return 'low';
  return null;
}

/** Ranks one board's tasks using the stored per-task flags for the project. */
export function loadExecutionRanks(
  projectId: string,
  tasks: NotionTask[],
): Map<string, ExecutionRank> {
  const flags = new Map<string, RankInputFlags>();
  const now = Date.now();
  for (const row of listTaskExecutionFlagsForProject(projectId)) {
    const expired = isExecuteNowExpired(row.execute_now_set_at, now);
    flags.set(normalizeTaskId(row.task_id), {
      urgent: row.urgent === 1,
      executeNowReason: expired ? null : row.execute_now_reason,
      executeNowSetAt: expired ? null : row.execute_now_set_at,
    });
  }
  const inputs: RankInputTask[] = tasks.map((t) => ({
    id: normalizeTaskId(t.id),
    status: t.status,
    dependsOn: t.dependsOn.map((d) => normalizeTaskId(d)),
    priority: parsePriority(t.priority),
  }));
  return computeExecutionRanks(inputs, flags);
}
