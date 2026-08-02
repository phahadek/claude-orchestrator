import { db } from '../db/db';
import { logger } from '../logger';
import { isGrantDenylisted } from '../session/orchestrator-config';
import {
  getCapabilityDisqualification,
  getCapabilityDisqualificationByInvestigationTask,
  upsertCapabilityDisqualification,
} from '../db/queries';
import type { CapabilityDisqualificationState } from '../db/types';

/**
 * A key qualifies for an auto-deny Investigation once it has this many
 * operator_denied/declined dispositions — see QUALIFYING_DISTINCT_TASK_COUNT
 * for the companion cross-task-diversity requirement. Structurally higher
 * than a one-click auto-allow suggestion's bar (see the sibling reversal-rate
 * design task): denying access is the safer default, so the auto-deny path
 * only ever files an Investigation for a human to weigh, never a ready
 * denylist-addition decision.
 */
const QUALIFYING_DENIAL_COUNT = 5;

/**
 * The pattern must span at least this many distinct originating task_ids —
 * rules out a single malformed task's session retrying the same request
 * over and over from inflating the denial count into a false capability-risk
 * signal.
 */
const QUALIFYING_DISTINCT_TASK_COUNT = 2;

const DENIAL_DISPOSITIONS = new Set(['operator_denied', 'declined']);
const APPROVAL_DISPOSITIONS = new Set(['operator_approved', 'auto_approved']);

interface CapabilityDispositionEvent {
  ts: number;
  disposition: string;
  taskId: string | null;
}

/** One (project, capability) key's full disposition history, mined from audit_log. */
type DispositionsByCapability = Map<
  string,
  Map<string, CapabilityDispositionEvent[]>
>;

interface AuditDispositionRow {
  ts: number;
  project_id: string | null;
  task_id: string | null;
  payload: string;
}

/**
 * Groups every capability_request_disposition audit_log row by
 * (project_id, capability). Rows with no project_id (an event that never
 * resolved to one) are skipped — the mining pass is project-scoped, matching
 * every other capability-request write path.
 */
function readDispositionsByCapability(): DispositionsByCapability {
  const rows = db
    .prepare<
      [],
      AuditDispositionRow
    >(`SELECT ts, project_id, task_id, payload FROM audit_log WHERE event_type = 'capability_request_disposition' ORDER BY id ASC`)
    .all();

  const byProject: DispositionsByCapability = new Map();
  for (const row of rows) {
    if (!row.project_id) continue;
    let payload: { capability?: unknown; disposition?: unknown };
    try {
      payload = JSON.parse(row.payload) as {
        capability?: unknown;
        disposition?: unknown;
      };
    } catch {
      continue;
    }
    if (
      typeof payload.capability !== 'string' ||
      typeof payload.disposition !== 'string'
    ) {
      continue;
    }

    let byCapability = byProject.get(row.project_id);
    if (!byCapability) {
      byCapability = new Map();
      byProject.set(row.project_id, byCapability);
    }
    let events = byCapability.get(payload.capability);
    if (!events) {
      events = [];
      byCapability.set(payload.capability, events);
    }
    events.push({
      ts: row.ts,
      disposition: payload.disposition,
      taskId: row.task_id,
    });
  }
  return byProject;
}

/** A (project, capability) key whose denial trail qualifies for an auto-deny Investigation. */
export interface CapabilityDenialPattern {
  projectId: string;
  capability: string;
  denialCount: number;
  taskIds: string[];
}

/**
 * Scans the full capability_request_disposition audit trail and returns
 * every (project_id, capability) key that currently qualifies for a
 * follow-on Investigation task, per the acceptance-criteria bar:
 *   - 5+ operator_denied/declined dispositions
 *   - zero operator_approved/auto_approved dispositions ever recorded for
 *     the key
 *   - spanning 2+ distinct originating task_ids
 *   - not already matched by GRANT_DENYLIST_PATTERNS
 *   - not already disqualified (an 'open' or 'hardened' row) — a 'lifted'
 *     key is eligible again, but only denials recorded after the lift count
 *     toward re-qualification; denials predating the lift are never
 *     recounted.
 */
export function findQualifyingDenialPatterns(): CapabilityDenialPattern[] {
  const byProject = readDispositionsByCapability();
  const patterns: CapabilityDenialPattern[] = [];

  for (const [projectId, byCapability] of byProject) {
    for (const [capability, events] of byCapability) {
      if (isGrantDenylisted(capability)) continue;

      const hasApproval = events.some((e) =>
        APPROVAL_DISPOSITIONS.has(e.disposition),
      );
      if (hasApproval) continue;

      const disqualification = getCapabilityDisqualification(
        projectId,
        capability,
      );
      if (disqualification && disqualification.state !== 'lifted') continue;

      const cutoffMs =
        disqualification?.state === 'lifted' && disqualification.lifted_at
          ? Date.parse(disqualification.lifted_at)
          : null;

      const eligibleDenials = events.filter((e) => {
        if (!DENIAL_DISPOSITIONS.has(e.disposition)) return false;
        if (cutoffMs !== null && !Number.isNaN(cutoffMs) && e.ts <= cutoffMs) {
          return false;
        }
        return true;
      });

      if (eligibleDenials.length < QUALIFYING_DENIAL_COUNT) continue;

      const distinctTaskIds = Array.from(
        new Set(
          eligibleDenials.map((e) => e.taskId).filter((t): t is string => !!t),
        ),
      );
      if (distinctTaskIds.length < QUALIFYING_DISTINCT_TASK_COUNT) continue;

      patterns.push({
        projectId,
        capability,
        denialCount: eligibleDenials.length,
        taskIds: distinctTaskIds,
      });
    }
  }

  return patterns;
}

/** Renders the evidence + open question an auto-deny Investigation task's body carries. */
export function renderInvestigationTaskBody(
  pattern: CapabilityDenialPattern,
): string {
  return [
    '## Evidence',
    '',
    `- Capability: \`${pattern.capability}\``,
    `- Denials recorded: ${pattern.denialCount} (operator_denied/declined, zero approvals ever recorded)`,
    `- Spanning ${pattern.taskIds.length} distinct tasks: ${pattern.taskIds.join(', ')}`,
    '',
    '## Open question',
    '',
    'Does this repeated-denial pattern reflect a genuine capability-level risk ' +
      '(a candidate for GRANT_DENYLIST_PATTERNS), or a recurring task-quality ' +
      'defect (sessions repeatedly reaching for this capability incorrectly, ' +
      'independent of the capability itself)?',
    '',
    'Resolving this Investigation is the sole mechanism that lifts or hardens ' +
      "this key's disqualification: concluding the root cause is addressed or " +
      'no longer applies lifts it (denial evidence resumes accumulating from ' +
      'that point); confirming genuine risk hardens it permanently, and may ' +
      'itself propose a GRANT_DENYLIST_PATTERNS change via a normal reviewed PR.',
  ].join('\n');
}

export function renderInvestigationTaskTitle(
  pattern: CapabilityDenialPattern,
): string {
  return `Recurring capability denial: ${pattern.capability}`;
}

/**
 * Records the disqualification a newly filed Investigation task opens for a
 * qualifying pattern — future mining passes skip this key while it's
 * 'open'. Idempotent: re-filing for the same key (should never happen while
 * 'open', since findQualifyingDenialPatterns excludes it) overwrites in
 * place rather than erroring.
 */
export function recordDisqualification(
  pattern: CapabilityDenialPattern,
  investigationTaskId: string,
  nowIso: string,
): void {
  upsertCapabilityDisqualification({
    project_id: pattern.projectId,
    capability: pattern.capability,
    investigation_task_id: investigationTaskId,
    state: 'open',
    created_at: nowIso,
    resolved_at: null,
    lifted_at: null,
    updated_at: nowIso,
  });
}

/** The verdict an Investigation task's resolution declares for a capability disqualification it's tied to. */
type CapabilityDisqualificationVerdict = 'lifted' | 'hardened';

/**
 * Reads the `capabilityDisqualificationVerdict` field an Investigation
 * task's freeform ops_journal `resolution` payload must carry to lift a
 * disqualification — the resolving session/operator's explicit "root cause
 * addressed" (lifted) vs "genuine risk confirmed" (hardened) call. Returns
 * null for anything else (missing, malformed, or an unrecognized value).
 * Module-private: only resolveCapabilityDisqualification (below) needs it.
 */
function capabilityDisqualificationVerdictFromResolution(
  resolution: unknown,
): CapabilityDisqualificationVerdict | null {
  if (!resolution || typeof resolution !== 'object') return null;
  const verdict = (
    resolution as { capabilityDisqualificationVerdict?: unknown }
  ).capabilityDisqualificationVerdict;
  return verdict === 'lifted' || verdict === 'hardened' ? verdict : null;
}

/**
 * Applies an Investigation task's terminal (resolved) disposition to the
 * capability disqualification it opened — the sole mechanism (per the
 * acceptance criteria) that lifts or hardens a disqualified key. Called from
 * ops/opsJournal.ts's setEntryState on every transition into 'resolved'; a
 * no-op if `investigationTaskId` isn't tied to an open disqualification
 * (already resolved, or never a capability-disposition Investigation in the
 * first place).
 *
 * `resolution` is the entry's raw (already-parsed) resolution payload — see
 * capabilityDisqualificationVerdictFromResolution. A resolved Investigation
 * that is tied to an open disqualification but never declared a verdict
 * defaults to 'hardened': erring toward keeping the key disqualified is
 * safer than silently reopening auto-deny mining on it, and there is no
 * passive/time-based expiry to fall back on.
 */
export function resolveCapabilityDisqualification(
  investigationTaskId: string,
  resolution: unknown,
  nowIso: string,
): void {
  const row =
    getCapabilityDisqualificationByInvestigationTask(investigationTaskId);
  if (!row || row.state !== 'open') return;

  let verdict = capabilityDisqualificationVerdictFromResolution(resolution);
  if (!verdict) {
    logger.warn(
      `[capabilityDispositionMining] Investigation ${investigationTaskId} resolved ` +
        `for disqualified capability "${row.capability}" (project ${row.project_id}) with no ` +
        'explicit capabilityDisqualificationVerdict — defaulting to hardened',
    );
    verdict = 'hardened';
  }

  const state: CapabilityDisqualificationState =
    verdict === 'lifted' ? 'lifted' : 'hardened';
  upsertCapabilityDisqualification({
    project_id: row.project_id,
    capability: row.capability,
    investigation_task_id: row.investigation_task_id,
    state,
    created_at: row.created_at,
    resolved_at: nowIso,
    lifted_at: verdict === 'lifted' ? nowIso : null,
    updated_at: nowIso,
  });
}
