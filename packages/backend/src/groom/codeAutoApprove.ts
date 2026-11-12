import type { GroomingGateEntry } from './groomGate';
import {
  SEAM_MIGRATIONS_PATH_RE,
  extractPathToken,
  parseFilesPathsRawItems,
} from './groomLoad';
import {
  evaluateTripwire,
  TRIPWIRE_VERSION,
  type TripwireExtra,
} from './codeAutoApproveTripwire';
import { normalizeTaskId } from '../tasks/taskId';

const CODE_AUTO_APPROVE_STANDARD_VERSION = '1';

const MAX_LOC = 400;
const MAX_FILES = 10;
const MAX_COHESIVE_SEAMS = 2;

const ALLOWED_MEMBER_KINDS: ReadonlySet<string> = new Set([
  'task.setStatus',
  'task.updateBody',
  'task.patchBodySection',
  'task.setProperties',
  'task.setDependsOn',
]);

interface CodeAutoApproveMember {
  kind: string;
  taskId: string | null;
}

/**
 * Every fact is fail-closed: `null` (or a missing value) means "unknown" and
 * counts as a failing condition.
 */
export interface CodeAutoApproveInput {
  /** Display-format Task Type of the flipped task, e.g. '💻 Code'. */
  taskType: string | null;
  /** checkReadiness + checkGroomingPromotionGate both passed at this commit-time evaluation. */
  readinessAndGroomingGatePassed: boolean;
  /** The originating session staged a decision.pickOne for any task; null = unknown. */
  sessionStagedDecisionPickOne: boolean | null;
  groomingGate: GroomingGateEntry | undefined;
  /** Composed post-commit task body; null = unknown. */
  body: string | null;
  members: CodeAutoApproveMember[];
  /** The proposed dependsOn list of each `task.setDependsOn` member. */
  proposedDependsOn: string[][];
  /** The task's current Depends On; null = unknown. */
  currentDependsOn: string[] | null;
  tripwireExtra?: TripwireExtra;
}

interface CodeAutoApproveCondition {
  id: string;
  passed: boolean;
  value?: unknown;
}

export interface CodeAutoApproveResult {
  eligible: boolean;
  evidence: {
    standard: 'code-auto-approve';
    standardVersion: string;
    tripwireVersion: string;
    conditions: CodeAutoApproveCondition[];
    tripwireMatches: unknown[];
  };
}

/** Paths named by the body's `## Files / paths affected` section. */
export function extractTouchedPaths(body: string): string[] {
  const lines = body.split('\n');
  const start = lines.findIndex((l) =>
    /^#{1,6}\s*files\s*\/\s*paths\s+affected\b/i.test(l.trim()),
  );
  if (start === -1) return [];
  const section: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line.trim())) break;
    section.push(line);
  }
  const paths: string[] = [];
  for (const { raw } of parseFilesPathsRawItems(section.join('\n'))) {
    const token = extractPathToken(raw);
    if (token) paths.push(token);
  }
  return paths;
}

function sizeConditionValue(gate: GroomingGateEntry | undefined): {
  passed: boolean;
  value: unknown;
} {
  const sc = gate?.size_check;
  if (!sc) return { passed: false, value: null };
  const { decision, loc, files } = sc;
  const passed =
    decision === 'no_split' &&
    typeof loc === 'number' &&
    Number.isFinite(loc) &&
    loc <= MAX_LOC &&
    typeof files === 'number' &&
    Number.isFinite(files) &&
    files <= MAX_FILES;
  return { passed, value: { decision, loc, files } };
}

function seamConditionValue(gate: GroomingGateEntry | undefined): {
  passed: boolean;
  value: unknown;
} {
  const sc = gate?.seam_check;
  if (!sc) return { passed: false, value: null };
  const seams = Array.isArray(sc.seams) ? (sc.seams as unknown[]) : null;
  const hasSchemaSeam =
    seams === null ||
    seams.some(
      (s) =>
        typeof s !== 'object' ||
        s === null ||
        (s as { kind?: unknown }).kind === 'schema',
    );
  let passed = false;
  if (sc.decision === 'single_seam') {
    passed = !hasSchemaSeam;
  } else if (sc.decision === 'cohesive') {
    passed =
      seams !== null && seams.length <= MAX_COHESIVE_SEAMS && !hasSchemaSeam;
  }
  return {
    passed,
    value: { decision: sc.decision, seamCount: seams?.length ?? null },
  };
}

export function evaluateCodeAutoApprove(
  input: CodeAutoApproveInput,
): CodeAutoApproveResult {
  const conditions: CodeAutoApproveCondition[] = [];
  const add = (id: string, passed: boolean, value?: unknown): void => {
    conditions.push(
      value === undefined ? { id, passed } : { id, passed, value },
    );
  };

  add('is_code_task', input.taskType === '💻 Code', input.taskType);
  add('readiness_and_grooming_gate', input.readinessAndGroomingGatePassed);
  add(
    'no_decision_pick_one',
    input.sessionStagedDecisionPickOne === false,
    input.sessionStagedDecisionPickOne,
  );

  const size = sizeConditionValue(input.groomingGate);
  add('size_check', size.passed, size.value);
  const seam = seamConditionValue(input.groomingGate);
  add('seam_check', seam.passed, seam.value);

  const touchedPaths =
    input.body === null ? null : extractTouchedPaths(input.body);
  const migrationPaths = (touchedPaths ?? []).filter((p) =>
    SEAM_MIGRATIONS_PATH_RE.test(p),
  );
  add(
    'no_migrations_path',
    touchedPaths !== null && migrationPaths.length === 0,
    migrationPaths,
  );

  const taskIds = new Set(
    input.members.map((m) => (m.taskId ? normalizeTaskId(m.taskId) : '')),
  );
  const membersOk =
    input.members.length > 0 &&
    input.members.every((m) => ALLOWED_MEMBER_KINDS.has(m.kind)) &&
    taskIds.size === 1 &&
    !taskIds.has('') &&
    input.members.some((m) => m.kind === 'task.setStatus');
  add(
    'member_kinds',
    membersOk,
    input.members.map((m) => m.kind),
  );

  let dependsOnOk = true;
  if (input.proposedDependsOn.length > 0) {
    if (input.currentDependsOn === null) {
      dependsOnOk = false;
    } else {
      const current = input.currentDependsOn.map((id) => normalizeTaskId(id));
      dependsOnOk = input.proposedDependsOn.every((proposed) => {
        const next = new Set(proposed.map((id) => normalizeTaskId(id)));
        return current.every((id) => next.has(id));
      });
    }
  }
  add('depends_on_superset', dependsOnOk);

  let tripwireMatches: unknown[] = [];
  if (touchedPaths === null || input.body === null) {
    add('tripwire', false);
  } else {
    const tripwire = evaluateTripwire({
      paths: touchedPaths,
      body: input.body,
      extra: input.tripwireExtra,
    });
    tripwireMatches = tripwire.matches;
    add('tripwire', !tripwire.matched);
  }

  return {
    eligible: conditions.every((c) => c.passed),
    evidence: {
      standard: 'code-auto-approve',
      standardVersion: CODE_AUTO_APPROVE_STANDARD_VERSION,
      tripwireVersion: String(TRIPWIRE_VERSION),
      conditions,
      tripwireMatches,
    },
  };
}
