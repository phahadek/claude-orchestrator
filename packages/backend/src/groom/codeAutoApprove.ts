import type { GroomingGateEntry } from './groomGate';
import { SEAM_MIGRATIONS_PATH_RE } from './groomLoad';
import { normalizeBoardId } from '../tasks/taskId';
import type { TripwireResult } from './codeAutoApproveTripwire';

export const CODE_AUTO_APPROVE_STANDARD_VERSION = '1';
export const CODE_AUTO_APPROVE_TYPE = '💻 Code';

const MAX_LOC = 400;
const MAX_FILES = 10;
const MAX_COHESIVE_SEAMS = 2;

export const ALLOWED_MEMBER_KINDS: ReadonlySet<string> = new Set([
  'task.setStatus',
  'task.updateBody',
  'task.patchBodySection',
  'task.setProperties',
  'task.setDependsOn',
  'gate.accrete',
  'seed.stage',
]);

const SOURCE_TASK_KINDS: ReadonlySet<string> = new Set([
  'gate.accrete',
  'seed.stage',
]);

/** Task a group member targets: payload.taskId, or payload.sourceTask.id for accretion kinds. */
export function memberTaskId(kind: string, payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as { taskId?: unknown; sourceTask?: { id?: unknown } };
  if (typeof p.taskId === 'string') return p.taskId;
  if (SOURCE_TASK_KINDS.has(kind) && typeof p.sourceTask?.id === 'string') {
    return p.sourceTask.id;
  }
  return null;
}

interface CodeAutoApproveMember {
  kind: string;
  /** Task the member targets; null when it could not be determined. */
  taskId: string | null;
}

export interface CodeAutoApproveInput {
  taskId: string;
  groomingGate: GroomingGateEntry | undefined;
  /** checkReadiness reported no violations AND checkGroomingPromotionGate allowed; null = could not evaluate. */
  readinessAndGatePass: boolean | null;
  /** Whether the originating session staged any decision.pickOne; null = unknown. */
  sessionStagedPickOne: boolean | null;
  members: CodeAutoApproveMember[];
  /** Paths the task declares it touches; null = could not be determined. */
  touchedPaths: string[] | null;
  /** The group's proposed Depends On (null when it carries no setDependsOn). */
  proposedDependsOn: string[] | null;
  /** The task's current Depends On; null = unknown. */
  currentDependsOn: string[] | null;
  tripwire: TripwireResult | null;
}

interface CodeAutoApproveCondition {
  id: string;
  passed: boolean;
  value?: unknown;
}

export interface CodeAutoApproveVerdict {
  eligible: boolean;
  conditions: CodeAutoApproveCondition[];
}

function evalSize(
  entry: GroomingGateEntry | undefined,
): CodeAutoApproveCondition {
  const sc = entry?.size_check;
  const value = {
    decision: sc?.decision ?? null,
    loc: sc?.loc ?? null,
    files: sc?.files ?? null,
  };
  const passed =
    sc?.decision === 'no_split' &&
    typeof sc.loc === 'number' &&
    Number.isFinite(sc.loc) &&
    sc.loc <= MAX_LOC &&
    typeof sc.files === 'number' &&
    Number.isFinite(sc.files) &&
    sc.files <= MAX_FILES;
  return { id: 'size', passed, value };
}

function evalSeams(
  entry: GroomingGateEntry | undefined,
): CodeAutoApproveCondition {
  const sc = entry?.seam_check;
  const decision = sc?.decision;
  const seams = Array.isArray(sc?.seams) ? (sc.seams as unknown[]) : null;
  const value = {
    decision: decision ?? null,
    seamCount: seams?.length ?? null,
  };
  if (!seams) return { id: 'seams', passed: false, value };
  const noSchema = seams.every((s) => {
    const kind =
      s && typeof s === 'object' ? (s as { kind?: unknown }).kind : undefined;
    return typeof kind === 'string' && kind !== 'schema';
  });
  const passed =
    noSchema &&
    (decision === 'single_seam' ||
      (decision === 'cohesive' && seams.length <= MAX_COHESIVE_SEAMS));
  return { id: 'seams', passed, value };
}

function evalDependsOn(
  proposed: string[] | null,
  current: string[] | null,
): CodeAutoApproveCondition {
  if (proposed === null) return { id: 'depends_on_superset', passed: true };
  if (current === null) {
    return { id: 'depends_on_superset', passed: false, value: 'unknown' };
  }
  const have = new Set(proposed.map((d) => normalizeBoardId(d)));
  const removed = current.filter((d) => !have.has(normalizeBoardId(d)));
  return {
    id: 'depends_on_superset',
    passed: removed.length === 0,
    value: { removed },
  };
}

export function evaluateCodeAutoApprove(
  input: CodeAutoApproveInput,
): CodeAutoApproveVerdict {
  const conditions: CodeAutoApproveCondition[] = [];

  conditions.push({
    id: 'readiness_and_gate',
    passed: input.readinessAndGatePass === true,
  });
  conditions.push({
    id: 'no_decision_pick_one',
    passed: input.sessionStagedPickOne === false,
  });
  conditions.push(evalSize(input.groomingGate));
  conditions.push(evalSeams(input.groomingGate));

  const migrationPaths =
    input.touchedPaths?.filter((p) => SEAM_MIGRATIONS_PATH_RE.test(p)) ?? [];
  conditions.push({
    id: 'no_migration_path',
    passed:
      input.touchedPaths !== null &&
      input.touchedPaths.length > 0 &&
      migrationPaths.length === 0,
    value: input.touchedPaths === null ? 'unknown' : { migrationPaths },
  });

  const target = normalizeBoardId(input.taskId);
  const badMembers = input.members.filter(
    (m) =>
      !ALLOWED_MEMBER_KINDS.has(m.kind) ||
      m.taskId === null ||
      normalizeBoardId(m.taskId) !== target,
  );
  conditions.push({
    id: 'member_kinds_single_task',
    passed: input.members.length > 0 && badMembers.length === 0,
    value: { rejected: badMembers.map((m) => m.kind) },
  });

  conditions.push(
    evalDependsOn(input.proposedDependsOn, input.currentDependsOn),
  );

  conditions.push({
    id: 'tripwire_clear',
    passed: input.tripwire !== null && !input.tripwire.matched,
    value: input.tripwire === null ? 'unknown' : input.tripwire.matches.length,
  });

  return { eligible: conditions.every((c) => c.passed), conditions };
}

export interface TriageCleanAutoApproveInput {
  taskId: string;
  /** Completeness check reported no failure AND checkGroomingPromotionGate (which enforces the triage clean floor) allowed; null = could not evaluate. */
  completenessAndGatePass: boolean | null;
  sessionStagedPickOne: boolean | null;
  members: CodeAutoApproveMember[];
  proposedDependsOn: string[] | null;
  currentDependsOn: string[] | null;
}

/** Fail-closed standard for triage-eligible (non-Code) types; the clean floor itself is enforced by the promotion gate. */
export function evaluateTriageCleanAutoApprove(
  input: TriageCleanAutoApproveInput,
): CodeAutoApproveVerdict {
  const conditions: CodeAutoApproveCondition[] = [
    {
      id: 'triage_clean_and_gate',
      passed: input.completenessAndGatePass === true,
    },
    {
      id: 'no_decision_pick_one',
      passed: input.sessionStagedPickOne === false,
    },
  ];

  const target = normalizeBoardId(input.taskId);
  const badMembers = input.members.filter(
    (m) =>
      !ALLOWED_MEMBER_KINDS.has(m.kind) ||
      m.taskId === null ||
      normalizeBoardId(m.taskId) !== target,
  );
  conditions.push({
    id: 'member_kinds_single_task',
    passed: input.members.length > 0 && badMembers.length === 0,
    value: { rejected: badMembers.map((m) => m.kind) },
  });
  conditions.push(
    evalDependsOn(input.proposedDependsOn, input.currentDependsOn),
  );
  return { eligible: conditions.every((c) => c.passed), conditions };
}

/** Extracts the `## Files / paths affected` section's declared path tokens, or null if the section is absent. */
export function extractDeclaredPaths(
  body: string,
  extractPathToken: (line: string) => string | null,
): string[] | null {
  const lines = body.split('\n');
  const start = lines.findIndex((l) =>
    /^##\s+Files\s*\/\s*paths affected\b/i.test(l),
  );
  if (start < 0) return null;
  const paths: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line)) break;
    if (!/^\s*[-*]\s+/.test(line)) continue;
    const token = extractPathToken(line);
    if (token) paths.push(token);
  }
  return paths;
}
