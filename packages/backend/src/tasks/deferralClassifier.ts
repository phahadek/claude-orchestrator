/**
 * Tier-3 semantic readiness advisory — a one-shot, headless classifier that
 * flags paraphrased deferrals (a genuine decision punted to implementation
 * time, worded to dodge the Tier-2 lexical list in readinessGate.ts).
 * Advisory-only: this module never gates a Ready transition (that stays the
 * deterministic tiers' + the human's authority — see readinessGate.ts and
 * TaskWriteCommands.setStatus). It writes a verdict into the staged
 * task.setStatus intent's `advisory` field, which the decision surface
 * (owned by the M12 decision-loop follow-on tasks) reads as a caution
 * signal distinct from the `annotation` hard-block channel.
 *
 * Reuses config.claudePath but NOT CliSessionRunner: a one-shot --print
 * classify call needs no tools, worktree, MCP config, or stream-json
 * protocol — spinning up the full session machinery for it would be
 * needless weight. No Anthropic API key is introduced; the CLI carries its
 * own credentials (Master Context Key Decision 2026-03-29).
 */

import { spawn, type ChildProcess } from 'child_process';
import { config, runtimeSettings } from '../config';
import { getTaskBackend } from './TaskBackend';
import {
  checkReadiness,
  composeProposedBody,
  DEFERRAL_PHRASES,
} from './readinessGate';
import {
  incrementRouteBackCount,
  listStagedIntentsByGroup,
  setStagedIntentAdvisory,
} from '../db/queries';
import type { StagedIntentRow } from '../db/types';
import type { TaskBodySections } from './bodyRender';
import { recordEvent } from '../audit/AuditLog';
import { placeSessionPid } from '../session/sessionCgroup';
import { logger } from '../logger';
import { getCachedType } from './TaskWriteCommands';
import { recordObservedUsageLimit } from '../orchestration/usageAdmission';
import { pushBackGroupToOriginatingSession } from '../routes/stagedIntents';
import type { PlanningOrchestrator } from '../orchestration/PlanningOrchestrator';
import type { SessionManager } from '../session/SessionManager';

interface AdvisoryFinding {
  detail: string;
  location?: string;
  quote?: string;
}

interface Advisory {
  tier: 'semantic';
  status: 'pending' | 'clean' | 'flagged' | 'errored' | 'usage_limited';
  confidence: number;
  findings: AdvisoryFinding[];
  model: string;
  checkedAt: number;
}

interface SetStatusPayload {
  taskId: string;
  status: string;
}

interface UpdateBodyPayload {
  taskId: string;
  sections: TaskBodySections;
}

/** Only these task Types carry implementer work worth screening — 📐 Design / 📋 Planning tasks have no implementation body to defer. */
const IMPLEMENTER_BEARING_TYPES: ReadonlySet<string> = new Set([
  '💻 Code',
  '🔧 Operational',
  '🧪 Testing',
]);

/** Gates whether a `flagged` verdict is significant enough to surface/route-back. Runtime tuning is Future Scope. */
const FLAG_CONFIDENCE_THRESHOLD = 0.7;

/** Fast timeout — a headless one-shot classify call must never hang a Ready-flip batch. */
const CLASSIFY_TIMEOUT_MS = 20_000;

/** Bounds how many classify subprocesses run at once for a batch of Ready-flips. */
const MAX_CONCURRENT_CLASSIFICATIONS = 3;

/** Delay before the single retry after a usage-limit termination — a single retry may land after the per-call rate limit has cleared. */
const USAGE_LIMIT_RETRY_DELAY_MS = 5_000;

const DEFERRAL_CLASSIFIER_PROMPT = `You are a narrow classifier. Your ONLY job is to find sentences in a software task's description that defer a genuine decision to implementation-time — i.e. to "whoever writes the code" — WITHOUT using any of the well-known phrases already caught by a separate deterministic filter. You are looking for PARAPHRASES of those phrases, not the phrases themselves.

Already caught by the deterministic filter (do NOT flag these verbatim phrases — they never reach you):
${DEFERRAL_PHRASES.map((p) => `- "${p}"`).join('\n')}

Find sentences that convey the SAME MEANING as the above using different words — e.g. "the exact approach here is up to whoever picks this up", "we'll work out the details when someone builds this", "left open for the person implementing to sort out". High confidence should be reported ONLY when a specific sentence defers a real, consequential decision (an API shape, a data model choice, a security/auth boundary, a UX behavior) to implementation time.

MUST NOT FLAG (these are normal, healthy task-writing and are NOT deferrals):
- A sentence describing a step the implementer will take (e.g. "the implementer adds a new column", "the implementer wires the route") — this describes WORK, not an unresolved DECISION.
- A resolved reference to a linked decision made elsewhere (e.g. "per the linked design doc, use approach X", "as decided in TASK-123, the schema is Y") — the decision was already made; this is just a pointer to it.
- Acceptance criteria naming implementer actions (e.g. "the implementer writes a migration", "the implementer runs the test suite") — this is scope description, not deferred judgment.

Respond with ONLY a JSON object (no markdown fences, no commentary) of this exact shape:
{"status": "clean" | "flagged", "confidence": <number 0..1>, "findings": [{"quote": "<exact sentence>", "detail": "<why this is a paraphrased deferral>"}]}

"status" must be "flagged" only if at least one finding has confidence >= 0.7. "findings" must be empty when status is "clean".`;

interface ClassifyResult {
  status: 'clean' | 'flagged';
  confidence: number;
  findings: AdvisoryFinding[];
}

/** Shape of `claude --print --output-format json`'s top-level stdout object. */
interface CliTopLevelJson {
  result?: string;
  is_error?: boolean;
  api_error_status?: number;
}

/** Tolerates a ```json (or bare ```) fence around the model's reply — the prompt forbids it, but the model emits one anyway. */
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const m = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  return m ? m[1].trim() : trimmed;
}

/** Mirrors eventKind.ts's isUsageLimitResult check, adapted for the one-shot --print JSON payload shape rather than a session 'result' event. */
function isUsageLimitPayload(parsed: CliTopLevelJson): boolean {
  return parsed.api_error_status === 429 || parsed.is_error === true;
}

/**
 * Detects a usage-limit termination in the raw stdout before it's treated as
 * an unparseable verdict — the CLI exits 0 on this path and returns the
 * limit message (not JSON) in `result`, which would otherwise fail
 * JSON.parse(stripCodeFence(...)) inside parseClassifyOutput and get
 * misreported as a generic parse error.
 */
function detectUsageLimit(stdout: string): {
  isUsageLimit: boolean;
  message?: string;
} {
  let parsed: CliTopLevelJson;
  try {
    parsed = JSON.parse(stdout) as CliTopLevelJson;
  } catch {
    return { isUsageLimit: false };
  }
  if (!isUsageLimitPayload(parsed)) return { isUsageLimit: false };
  return {
    isUsageLimit: true,
    message: typeof parsed.result === 'string' ? parsed.result : undefined,
  };
}

function parseClassifyOutput(stdout: string): ClassifyResult {
  const parsed = JSON.parse(stdout) as CliTopLevelJson;
  // `claude --print --output-format json` wraps the model's reply in a
  // `result` string field; fall back to raw stdout for forward-compat.
  const raw = typeof parsed.result === 'string' ? parsed.result : stdout;
  const verdict = JSON.parse(stripCodeFence(raw)) as {
    status?: unknown;
    confidence?: unknown;
    findings?: unknown;
  };
  const confidence =
    typeof verdict.confidence === 'number' ? verdict.confidence : 0;
  // Defense-in-depth: only ever surface 'flagged' when the model's own
  // confidence clears the threshold, regardless of what status string it
  // returned — a below-threshold "flagged" is not significant enough to
  // drive a route-back and is reported as clean.
  const status =
    verdict.status === 'flagged' && confidence >= FLAG_CONFIDENCE_THRESHOLD
      ? 'flagged'
      : 'clean';
  const findings = Array.isArray(verdict.findings)
    ? (verdict.findings as unknown[])
        .filter(
          (f): f is Record<string, unknown> =>
            typeof f === 'object' && f !== null,
        )
        .map((f) => ({
          detail: typeof f.detail === 'string' ? f.detail : '',
          location: typeof f.location === 'string' ? f.location : undefined,
          quote: typeof f.quote === 'string' ? f.quote : undefined,
        }))
    : [];
  return { status, confidence, findings };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Invokes the claude CLI in one-shot headless print mode to classify a task
 * body for paraphrased deferrals, retrying exactly once after a short delay
 * if the first attempt hits the shared account's usage limit — a single
 * retry may land after the per-call rate limit has cleared. Whatever the
 * retried attempt yields (including a second 'usage_limited') is final; it
 * is never retried again. Preserves the fail-open contract: 'usage_limited'
 * and 'errored' both never block or auto-route-back a Ready transition.
 */
async function classifyDeferral(body: string): Promise<Advisory> {
  const first = await classifyDeferralOnce(body);
  if (first.status !== 'usage_limited') return first;
  await delay(USAGE_LIMIT_RETRY_DELAY_MS);
  return classifyDeferralOnce(body);
}

/**
 * Invokes the claude CLI in one-shot headless print mode to classify a task
 * body for paraphrased deferrals. Fails open: any spawn error, non-zero
 * exit, timeout, or unparseable output resolves to status:'errored' rather
 * than throwing — a classify failure must never block or auto-route-back.
 * A usage-limit termination (CLI exits 0, payload carries
 * api_error_status: 429 / is_error: true) resolves to status:'usage_limited'
 * instead, and feeds the shared usage-admission deferral gate immediately.
 */
async function classifyDeferralOnce(body: string): Promise<Advisory> {
  const model = runtimeSettings.tier3_classifier_model;
  const checkedAt = Date.now();
  return new Promise<Advisory>((resolve) => {
    let settled = false;
    const settle = (advisory: Advisory) => {
      if (settled) return;
      settled = true;
      resolve(advisory);
    };

    let proc: ChildProcess;
    try {
      proc = spawn(
        config.claudePath,
        [
          '--print',
          '--output-format',
          'json',
          '--model',
          model,
          DEFERRAL_CLASSIFIER_PROMPT + '\n\nTASK BODY:\n' + body,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      logger.warn(
        `[deferralClassifier] failed to spawn classify subprocess: ${(err as Error).message}`,
      );
      settle({
        tier: 'semantic',
        status: 'errored',
        confidence: 0,
        findings: [],
        model,
        checkedAt,
      });
      return;
    }

    if (proc.pid) placeSessionPid(proc.pid);

    let stdout = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    // Must be drained even though we only use it on the error path: an
    // unread stderr pipe fills its OS buffer (~64 KB) once the child writes
    // past it, blocking the child forever and stranding this call until the
    // CLASSIFY_TIMEOUT_MS timeout reaps it.
    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    proc.on('error', (err: Error) => {
      logger.warn(
        `[deferralClassifier] classify subprocess error: ${err.message}`,
      );
      settle({
        tier: 'semantic',
        status: 'errored',
        confidence: 0,
        findings: [],
        model,
        checkedAt,
      });
    });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      settle({
        tier: 'semantic',
        status: 'errored',
        confidence: 0,
        findings: [],
        model,
        checkedAt,
      });
    }, CLASSIFY_TIMEOUT_MS);

    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (code !== 0) {
        logger.warn(
          `[deferralClassifier] classify subprocess exited with code ${code}: ${stderr.trim()}`,
        );
        settle({
          tier: 'semantic',
          status: 'errored',
          confidence: 0,
          findings: [],
          model,
          checkedAt,
        });
        return;
      }
      const usageLimit = detectUsageLimit(stdout);
      if (usageLimit.isUsageLimit) {
        recordObservedUsageLimit(usageLimit.message);
        logger.warn(
          '[deferralClassifier] classify subprocess hit the shared account usage limit',
        );
        settle({
          tier: 'semantic',
          status: 'usage_limited',
          confidence: 0,
          findings: [],
          model,
          checkedAt,
        });
        return;
      }

      try {
        const result = parseClassifyOutput(stdout);
        settle({
          tier: 'semantic',
          status: result.status,
          confidence: result.confidence,
          findings: result.findings,
          model,
          checkedAt,
        });
      } catch (err) {
        logger.warn(
          `[deferralClassifier] failed to parse classify output: ${(err as Error).message}`,
        );
        settle({
          tier: 'semantic',
          status: 'errored',
          confidence: 0,
          findings: [],
          model,
          checkedAt,
        });
      }
    });
  });
}

/**
 * Small in-process semaphore so a batch of Ready-flips doesn't spawn
 * unbounded classify subprocesses. Exported for reuse by the test.request
 * governed lane's per-project concurrency cap (see
 * orchestration/testRequestLane.ts) — same bounded-concurrency need, just a
 * separate pool keyed per project instead of one process-wide pool.
 */
export class Semaphore {
  private available: number;
  private size: number;
  private readonly queue: { id: string | null; wake: () => void }[] = [];

  constructor(size: number) {
    this.available = size;
    this.size = size;
  }

  /** Count currently held (not available) — the admission-check peek, never mutates state. */
  inUse(): number {
    return this.size - this.available;
  }

  /** Current capacity — lets callers detect a configuration change and call resize(). */
  capacity(): number {
    return this.size;
  }

  /** Count of waiters currently parked in the wait queue (not yet holding a permit). */
  queueDepth(): number {
    return this.queue.length;
  }

  /**
   * 1-indexed position of a tracked waiter (see acquire's `id` param) within
   * the wait queue, or null when that id isn't currently queued — either it
   * already holds a permit, or it was never tracked (acquire called without
   * an id). Lets a caller report a live, decreasing position to whoever is
   * waiting on a permit (see orchestration/testRequestLane.ts's admission
   * reporting) without any bookkeeping beyond what the queue array already
   * carries.
   */
  positionOf(id: string): number | null {
    const idx = this.queue.findIndex((entry) => entry.id === id);
    return idx === -1 ? null : idx + 1;
  }

  /**
   * Adjusts capacity in place, preserving the in-use count of already-held
   * permits — so a live limit change (see getProjectSemaphore in
   * orchestration/testRequestLane.ts) takes effect without discarding
   * accounting for runs currently holding a permit. Growing capacity wakes
   * queued waiters up to the new headroom; shrinking just lowers the
   * available count (never revokes an already-held permit).
   */
  resize(newSize: number): void {
    this.available += newSize - this.size;
    this.size = newSize;
    while (this.available > 0 && this.queue.length > 0) {
      this.available--;
      const next = this.queue.shift()!;
      next.wake();
    }
  }

  /**
   * Acquires a permit, resolving immediately if one is available or queueing
   * FIFO otherwise. `id` is an optional caller-supplied identity — when
   * given, the waiter can look up its own live queue position via
   * positionOf(id) while parked. Purely additive: omitting it (every call
   * site outside testRequestLane.ts) behaves exactly as before.
   */
  async acquire(id: string | null = null): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.queue.push({
        id,
        wake: () => {
          this.available--;
          resolve(() => this.release());
        },
      });
    });
  }

  private release(): void {
    this.available++;
    const next = this.queue.shift();
    if (next) next.wake();
  }
}

const classifySemaphore = new Semaphore(MAX_CONCURRENT_CLASSIFICATIONS);

// Includes 'committed': the group-commit path (commitGroupIntents) invokes
// classifyReadyProposal fire-and-forget only after transitioning every
// member to 'committed', so by the time this async call actually reads the
// rows back, they're already past 'staged'/'approved'. The verify path
// (verifyGroup) still calls in while members sit at 'staged', so both are
// covered by the same set.
const ACTIVE_INTENT_STATES: ReadonlySet<StagedIntentRow['state']> = new Set([
  'staged',
  'approved',
  'committed',
]);

// A group can reach classifyReadyProposal via both verifyGroup (idle-park)
// and commitGroupIntents (group-commit) — process-lifetime dedup so an
// intent that traverses both paths is only ever sent to the classifier
// once. Advisory-only: safe to keep in memory rather than in the DB.
const classifiedIntentIds = new Set<string>();

/** Test-only: clears the process-lifetime dedup set so unit tests reusing the same fixture intent ids across cases don't collide. */
export function __resetClassifiedIntentIdsForTest(): void {
  classifiedIntentIds.clear();
}

function isReadyFlip(row: StagedIntentRow): boolean {
  if (row.kind !== 'task.setStatus' || !ACTIVE_INTENT_STATES.has(row.state)) {
    return false;
  }
  const payload = JSON.parse(row.payload) as SetStatusPayload;
  return payload.status === 'Ready';
}

/** The body the proposal would make effective at Ready: the group's live task.updateBody payload if present, else the stored page body. */
async function computeGroupProposedBody(
  groupRows: StagedIntentRow[],
  backend: ReturnType<typeof getTaskBackend>,
  taskId: string,
): Promise<string> {
  const stored = (await backend.fetchTaskPage(taskId)) ?? '';
  const updateBodyRow = groupRows.find(
    (row) =>
      row.kind === 'task.updateBody' &&
      ACTIVE_INTENT_STATES.has(row.state) &&
      (JSON.parse(row.payload) as UpdateBodyPayload).taskId === taskId,
  );
  if (!updateBodyRow) return stored;
  const payload = JSON.parse(updateBodyRow.payload) as UpdateBodyPayload;
  return composeProposedBody(stored, payload.sections);
}

/** True when a row's durably-persisted advisory (written by an earlier classifyReadyProposal call) is already 'flagged' — the DB-backed half of the route-back idempotency guard, robust across a process restart clearing classifiedIntentIds' in-memory dedup. */
function wasFlagged(advisoryJson: string | null): boolean {
  if (!advisoryJson) return false;
  try {
    return (
      (JSON.parse(advisoryJson) as { status?: unknown }).status === 'flagged'
    );
  } catch {
    return false;
  }
}

export interface ClassifyReadyProposalOptions {
  /**
   * True only at the pre-commit call site (verifyGroup, where group members
   * are still staged/approved and a pushback transition is legal). False (or
   * omitted) at the post-commit call site (commitGroupIntents' fire-and-
   * forget call, where members are already `committed` and have no legal
   * outgoing transition — STAGED_INTENT_TRANSITIONS' `committed: []`). A
   * 'flagged' verdict still calls incrementRouteBackCount either way, for
   * signal/escalation tracking; only the actual route-back transition is
   * gated on this flag.
   */
  preCommit?: boolean;
  planningOrchestrator?: PlanningOrchestrator;
  sessionManager?: SessionManager;
}

/**
 * Runs the Tier-3 classifier over each Ready-flip target in a proposal
 * group: gated on the deterministic tiers not already hard-blocking, and
 * only for implementer-bearing task types. Writes each verdict directly
 * into the target intent's `advisory` field and records an audit event
 * (mirroring `readiness_override`) so an operator returning from an
 * unattended run sees what happened.
 *
 * A genuine 'flagged' verdict drives the automatic route-back the
 * architecture record describes: incrementRouteBackCount(groupId) is always
 * called, and — pre-commit, while under the cap — the group is pushed back
 * to its originating session through the existing feedback-inbox pushback
 * mechanism (pushBackGroupToOriginatingSession), the same path an
 * operator-initiated group pushback takes. Once escalated, or post-commit,
 * the group is left for ordinary operator disposition instead.
 */
export async function classifyReadyProposal(
  groupId: string,
  opts: ClassifyReadyProposalOptions = {},
): Promise<void> {
  const groupRows = listStagedIntentsByGroup(groupId);
  const readyFlips = groupRows.filter(isReadyFlip);
  if (readyFlips.length === 0) {
    logger.info(
      `[deferralClassifier] skip guard=no-ready-flips groupId=${groupId}`,
    );
    return;
  }

  // Captured before this call overwrites any row's advisory below — lets a
  // freshly (re-)computed 'flagged' verdict be told apart from one that was
  // already durably flagged by an earlier call (e.g. verifyGroup's
  // pre-commit pass), so a route-back is only ever counted once per genuine
  // flagged classification even across a process restart, which would clear
  // classifiedIntentIds' in-memory dedup below.
  const previouslyFlagged = new Set(
    readyFlips.filter((row) => wasFlagged(row.advisory)).map((row) => row.id),
  );

  const newlyFlaggedFlags = await Promise.all(
    readyFlips.map(async (row) => {
      const payload = JSON.parse(row.payload) as SetStatusPayload;
      const taskType = getCachedType(payload.taskId);
      if (!taskType || !IMPLEMENTER_BEARING_TYPES.has(taskType)) {
        logger.info(
          `[deferralClassifier] skip taskId=${payload.taskId} guard=task-type ` +
            `taskType=${taskType ?? 'null'}`,
        );
        return false;
      }

      const backend = getTaskBackend(row.project_id);
      const body = await computeGroupProposedBody(
        groupRows,
        backend,
        payload.taskId,
      );

      const readinessViolations = checkReadiness(body, taskType);
      if (readinessViolations.length > 0) {
        logger.info(
          `[deferralClassifier] skip taskId=${payload.taskId} guard=readiness ` +
            `violations=${readinessViolations.map((v) => v.tier).join(',')}`,
        );
        return false;
      }

      if (classifiedIntentIds.has(row.id)) return false;
      classifiedIntentIds.add(row.id);

      const release = await classifySemaphore.acquire();
      let advisory: Advisory;
      try {
        advisory = await classifyDeferral(body);
      } finally {
        release();
      }

      setStagedIntentAdvisory(row.id, JSON.stringify(advisory));

      logger.info(
        `[deferralClassifier] classified taskId=${payload.taskId} status=${advisory.status}`,
      );

      recordEvent({
        event_type: 'readiness_override',
        actor_type: 'system',
        actor_id: null,
        project_id: row.project_id,
        task_id: payload.taskId,
        payload: {
          reason: 'tier3_semantic_advisory',
          status: advisory.status,
          confidence: advisory.confidence,
          findings: advisory.findings,
          model: advisory.model,
          groupId,
        },
      });

      return advisory.status === 'flagged' && !previouslyFlagged.has(row.id);
    }),
  );

  if (!newlyFlaggedFlags.some(Boolean)) return;

  const { escalated } = incrementRouteBackCount(groupId);
  if (escalated || !opts.preCommit) {
    logger.info(
      `[deferralClassifier] flagged groupId=${groupId} escalated=${escalated} ` +
        `preCommit=${Boolean(opts.preCommit)} — leaving for operator disposition`,
    );
    return;
  }

  await pushBackGroupToOriginatingSession(
    groupId,
    'Tier-3 semantic advisory flagged a paraphrased deferral in this ' +
      "group's proposed body — revise to resolve the flagged decision " +
      'before re-proposing Ready.',
    opts.planningOrchestrator,
    opts.sessionManager,
  ).catch((err) => {
    logger.error(
      `[deferralClassifier] auto-route-back failed groupId=${groupId}: ${(err as Error).message}`,
    );
  });
}
