import { logger } from '../logger';

export type PriorityLevel = 'critical' | 'high' | 'medium' | 'low';

const UNSET_PRIORITY_RANK = 4;

const LEVEL_RANK: Record<PriorityLevel, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const warnedValues = new Set<string>();

/** Maps a raw board Priority string (e.g. '🔴 Critical', '🟠 High') to a canonical level; unrecognised non-empty values are logged once and treated as unset. */
export function normalizePriority(
  raw: string | null | undefined,
): PriorityLevel | null {
  if (!raw || !raw.trim()) return null;
  const s = raw.toLowerCase();
  if (s.includes('critical')) return 'critical';
  if (s.includes('high')) return 'high';
  if (s.includes('medium')) return 'medium';
  if (s.includes('low')) return 'low';
  if (!warnedValues.has(raw)) {
    warnedValues.add(raw);
    logger.warn(
      `[priority] unrecognised Priority value "${raw}" ranked as unset`,
    );
  }
  return null;
}

/** Lower is more urgent: critical 0, high 1, medium 2, low 3, unset 4. */
export function priorityLevelRank(level: PriorityLevel | null): number {
  return level === null ? UNSET_PRIORITY_RANK : LEVEL_RANK[level];
}
