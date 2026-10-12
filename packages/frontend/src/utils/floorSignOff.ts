import { parsePauseReasonSet } from '@claude-orchestrator/backend/src/db/pauseReason';

export interface FloorPauseEntry {
  reason: string;
  detail?: string | null;
  blocks_merge?: boolean;
}

export interface FloorSignOff {
  categories: string | null;
  paths: string | null;
  /** Floor is the only merge-blocking entry — only the operator's sign-off remains. */
  ready: boolean;
  /** Reasons of the other merge-blocking entries (empty when ready). */
  otherBlockingReasons: string[];
}

export const FLOOR_HEADLINE = 'Sign-off required';
export const FLOOR_APPROVE_LABEL = 'Sign off';
export const FLOOR_READY_COPY =
  'Ready for sign-off — review is complete; only your sign-off remains.';
export const FLOOR_IN_PROGRESS_COPY = 'Review in progress';
export const FLOOR_DETAILS_UNAVAILABLE =
  'matched categories unavailable (recorded before details were persisted)';

export function parseFloorDetail(detail: string | null | undefined): {
  categories: string | null;
  paths: string | null;
} {
  const text = detail ?? '';
  const start = text.indexOf('touches ');
  const end = text.indexOf(' path(s)', start);
  if (start === -1 || end === -1) return { categories: null, paths: null };
  const categories = text.slice(start + 'touches '.length, end).trim();
  const rest = text.slice(end + ' path(s)'.length);
  const paths = rest.startsWith(': ') ? rest.slice(2).trim() : '';
  return { categories: categories || null, paths: paths || null };
}

export function deriveFloorSignOff(
  entries: FloorPauseEntry[] | null | undefined,
): FloorSignOff | null {
  const floor = entries?.find((e) => e.reason === 'baseline_escalation_floor');
  if (!floor) return null;
  const others = (entries ?? [])
    .filter(
      (e) =>
        e.reason !== 'baseline_escalation_floor' && e.blocks_merge !== false,
    )
    .map((e) => e.reason);
  return {
    ...parseFloorDetail(floor.detail),
    ready: others.length === 0,
    otherBlockingReasons: others,
  };
}

export function deriveFloorSignOffFromRaw(
  raw: string | null | undefined,
): FloorSignOff | null {
  if (!raw) return null;
  return deriveFloorSignOff(parsePauseReasonSet(raw));
}

export function floorToastMessage(message: string): string {
  const { categories, paths } = parseFloorDetail(message);
  return `Operator sign-off required — PR touches ${categories ?? 'baseline-floor'} path(s)${paths ? `: ${paths}` : ''}`;
}

export function isFloorEscalationMessage(message: string): boolean {
  return /Baseline escalation floor/i.test(message);
}
